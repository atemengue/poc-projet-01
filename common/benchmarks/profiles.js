// Profils de charge des scénarios (PC1, docs/decisions-conception.md), lus à la fois par k6
// (place-order.js) et par run-scenario.js : une seule définition des phases et de leur durée.
//
// Chaque phase : { name, seconds, rate } (rate en commandes/s). La phase est écrite dans le
// customerId de chaque commande (<RUN_ID>-<phase>-<n>) : latency.js retrouve exactement les
// commandes d'une phase, sans dépendre des horloges.
//
// measure : phase(s) dont les commandes donnent le verdict. fault : fenêtre de la panne (S3, S4,
// S4b), déclenchée par run-scenario.js au début de cette phase et levée à sa fin.

const WARMUP = { name: 'warmup', seconds: 60, rate: 50 }; // non compté (connexions froides, C2)

export const PROFILES = {
  // S1 : 3 min à 100 cmd/s (H2, H5).
  s1: {
    title: 'S1 — Charge normale',
    load: '100 cmd/s pendant 3 min (après 1 min de préchauffage à 50 cmd/s)',
    action: 'aucune',
    question: 'Les deux architectures satisfont-elles les exigences en conditions normales ?',
    hypotheses: [
      'Exigence S1 : acceptation p95 < 1 s et pas d\'accumulation, pour A et pour B',
      'H2 (latence) : complétion p95 de sync au moins 20 % plus faible que celle d\'async, et acceptation p95 de sync < 1 s',
      'H5 (observabilité) : async < 99 % de traces complètes, sync ≥ 99 %',
    ],
    phases: [WARMUP, { name: 'measure', seconds: 180, rate: 100 }],
    measure: ['measure'],
  },

  // S2 : paliers de 1 min (lecture de la dégradation), puis 5 min à 500 cmd/s (verdict H1).
  s2: {
    title: 'S2 — Pic de trafic',
    load: 'paliers de 1 min à 100, 200, 300, 400 cmd/s, puis 5 min à 500 cmd/s (fenêtre du verdict)',
    action: 'aucune',
    question: 'Quelle architecture se dégrade le plus progressivement quand la charge augmente ?',
    hypotheses: [
      'H1 (scalabilité, hypothèse centrale) : sur le palier à 500 cmd/s, async garde un débit accepté ≥ 95 % du débit offert, une acceptation p95 < 1 s et 0 violation de I1, alors que sync manque au moins un de ces seuils',
    ],
    phases: [
      WARMUP,
      { name: 'step-100', seconds: 60, rate: 100 },
      { name: 'step-200', seconds: 60, rate: 200 },
      { name: 'step-300', seconds: 60, rate: 300 },
      { name: 'step-400', seconds: 60, rate: 400 },
      { name: 'measure', seconds: 300, rate: 500 },
    ],
    measure: ['measure'],
  },

  // S3 : Payment à 2 s pendant 60 s, au milieu de 3 min à 100 cmd/s (H3c).
  s3: {
    title: 'S3 — Payment lent',
    load: '100 cmd/s pendant 3 min, sonde GET /orders/:id une fois par seconde',
    action: 'Payment répond en 2 s pendant 60 s (POST /admin/chaos), au milieu du run',
    question: 'Comment une dépendance lente affecte-t-elle l\'ensemble du workflow ?',
    hypotheses: [
      'H3c (résilience, dépendance lente) : async répond au client en p95 < 200 ms avec 0 abandon ; sync dépasse le délai client de 5 s pour plus de 50 % des commandes de la fenêtre',
    ],
    phases: [
      WARMUP,
      { name: 'before', seconds: 60, rate: 100 },
      { name: 'fault', seconds: 60, rate: 100 },
      { name: 'after', seconds: 60, rate: 100 },
    ],
    measure: ['fault'],
    fault: { kind: 'latency', service: 'payment', latencyMs: 2000 },
    probe: true, // sonde GET /orders/:id une fois par seconde (effet sur les autres requêtes)
  },

  // S4 : Payment arrêté 30 s (H3b).
  s4: {
    title: 'S4 — Payment indisponible',
    load: '100 cmd/s pendant 3 min',
    action: 'Payment arrêté 30 s (docker compose stop), puis redémarré',
    question: 'L\'architecture revient-elle à un état normal après la panne ?',
    hypotheses: [
      'H3b (résilience, dépendance critique) : async ne perd aucune commande, et ≥ 99 % des commandes de la panne sont dans un état final moins de 2 min après le retour de Payment',
    ],
    phases: [
      WARMUP,
      { name: 'before', seconds: 60, rate: 100 },
      { name: 'fault', seconds: 30, rate: 100 },
      { name: 'after', seconds: 90, rate: 100 },
    ],
    measure: ['fault'],
    fault: { kind: 'stop', service: 'payment' },
  },

  // S4b : Shipping arrêté 30 s (H3a).
  s4b: {
    title: 'S4b — Shipping indisponible (service secondaire)',
    load: '100 cmd/s pendant 3 min',
    action: 'Shipping arrêté 30 s (docker compose stop), puis redémarré',
    question: 'Une panne d\'un service secondaire empêche-t-elle de terminer les commandes ?',
    hypotheses: [
      'H3a (résilience, service secondaire) : async termine ≥ 99 % des commandes reçues pendant la panne moins de 2 min après le retour de Shipping',
    ],
    phases: [
      WARMUP,
      { name: 'before', seconds: 60, rate: 100 },
      { name: 'fault', seconds: 30, rate: 100 },
      { name: 'after', seconds: 90, rate: 100 },
    ],
    measure: ['fault'],
    fault: { kind: 'stop', service: 'shipping' },
  },

  // S5 : faible débit, doublons (H4). Les doublons sont produits par le broker en async
  // (DUPLICATE_DELIVERY) et par k6 en sync (requête renvoyée avec le même Idempotency-Key).
  s5: {
    title: 'S5 — Livraison multiple',
    load: '10 cmd/s pendant 1 min (après 1 min de préchauffage)',
    action: 'async : chaque événement livré deux fois (DUPLICATE_DELIVERY=2) ; sync : chaque requête renvoyée avec le même Idempotency-Key ; témoin avec --witness (protection désactivée)',
    question: 'Quelle complexité supplémentaire l\'asynchronisme introduit-il pour conserver les invariants ?',
    hypotheses: [
      'H4 (cohérence) : avec idempotence, 0 effet en double (I7) et 0 violation de I1, pour un surcoût de complétion p95 < 10 % ; le témoin doit montrer des doublons',
    ],
    phases: [{ name: 'warmup', seconds: 60, rate: 10 }, { name: 'measure', seconds: 60, rate: 10 }],
    measure: ['measure'],
  },
};

/** Début (en secondes depuis le lancement de k6) et fin de chaque phase. */
export function timeline(profile) {
  let t = 0;
  return profile.phases.map((p) => {
    const start = t;
    t += p.seconds;
    return { ...p, start, end: t };
  });
}

/** Phase en cours à un instant donné (secondes depuis le lancement de k6). */
export function phaseAt(profile, elapsedSeconds) {
  const phases = timeline(profile);
  return (phases.find((p) => elapsedSeconds < p.end) ?? phases[phases.length - 1]).name;
}

/** Durée totale du profil, en secondes. */
export function totalSeconds(profile) {
  return profile.phases.reduce((s, p) => s + p.seconds, 0);
}

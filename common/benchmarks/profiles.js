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
  s1: { phases: [WARMUP, { name: 'measure', seconds: 180, rate: 100 }], measure: ['measure'] },

  // S2 : paliers de 1 min (lecture de la dégradation), puis 5 min à 500 cmd/s (verdict H1).
  s2: {
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

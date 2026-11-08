# Résultats des scénarios

> Résultats mesurés, scénario par scénario, avec le fichier de `results/` qui les prouve (CLAUDE.md §10).
> `results/` n'est pas versionné : les chiffres sont recopiés ici, le chemin indique où les retrouver sur la machine de mesure.
> Un verdict n'est définitif qu'avec **trois répétitions concordantes** (`docs/hypotheses-assumption.md`, §4) ; tant que ce n'est pas le cas, il est marqué **provisoire**.
> Les essais à blanc (`results/dry-run/`, dossiers `*-essai*`) ne sont jamais cités ici.

---

## S1 — Charge normale, 100 cmd/s (exigence S1, H2, H5)

*Répétition 1, 2026-11-08. Profil `s1` : préchauffage 1 min à 50 cmd/s (non compté), puis 3 min à 100 cmd/s (phase `measure`). Traces échantillonnées à 10 % (PC3).*

| Run | Fichiers |
|---|---|
| sync | `results/sync/s1/rep-1/` |
| async | `results/async/s1/rep-1/` |

Les deux runs sont **valides** (aucune itération perdue par k6).

### Mesures (phase `measure`)

| Mesure | sync | async |
|---|---|---|
| Commandes mesurées | 17 913 | 17 976 |
| Débit reçu / accepté | 99,5 / 96,6 cmd/s | 99,9 / 96,7 cmd/s |
| Acceptation p50 / p95 / p99 | 53 / **68** / 318 ms | 53 / **77** / 167 ms |
| Complétion p50 / p95 / p99 | 98 / **146** / 615 ms | 100 / **162** / 334 ms |
| Réponse HTTP p95 (k6) | 154 ms | 11 ms |
| Abandons côté client | 0 | 0 |
| Drainage après le run | 0 s (rien en cours) | 0 s (rien en cours) |
| Traces complètes (commandes échantillonnées) | 1 846 / 1 846 (100 %) | 1 780 / 1 780 (100 %) |
| Invariants | OK | 2 violations de I9 (`confirmed_at < accepted_at`), artefact de mesure (voir plus bas) |

Le débit accepté est inférieur au débit reçu des 3 % de paiements refusés (D12), jamais « acceptés » : c'est attendu.

Sources : `run.json`, `latency.json` (`measure`), `invariants.json`, `traces.json` de chaque dossier.

### Lecture

1. **Exigence S1 respectée par les deux variantes** : acceptation p95 de 68 et 77 ms, très loin de 1 s ; aucun travail accumulé à la fin du run.
2. **Latence** : le synchrone complète un peu plus vite au p95 (146 contre 162 ms, soit 9,9 % de moins), mais l'asynchrone a une queue plus courte au p99 (334 contre 615 ms en complétion, 167 contre 318 ms en acceptation). Les latences simulées (50 + 10 + 20 + 10 ms) dominent dans les deux cas : à 100 cmd/s, aucune variante ne force.
3. **Réponse au client** : 11 ms en async (`202` dès l'enregistrement) contre 154 ms en sync (réponse après toute la chaîne).
4. **Traces** : 100 % de traces complètes dans les deux variantes ; la propagation du contexte à travers l'outbox (AS9) fonctionne. Le coût est dans l'effort d'instrumentation (code manuel, défauts trouvés en lisant les traces : M3, C6), pas dans le résultat.
5. **Violations de I9 en async** : 2 commandes sur 20 975 (run entier) ont un `confirmed_at` antérieur à leur `accepted_at`. Ce n'est pas une incohérence métier (I1 à I8 respectés, l'ordre réel est correct) : `now()` donne l'heure du début de la transaction, et deux événements de la même commande traités en même temps par Order peuvent ainsi écrire des heures inversées. Défaut de mesure connu, non corrigé : `docs/hypotheses-assumption.md`, §4.

### Verdicts

| Hypothèse | Verdict | Justification |
|---|---|---|
| Exigence S1 (p95 d'acceptation < 1 s, pas d'accumulation) | **Respectée par A et B — provisoire** (1 répétition sur 3) | 68 et 77 ms ; drainage nul |
| **H2** (sync : complétion p95 au moins 20 % plus faible, et acceptation p95 < 1 s) | **Rejetée — provisoire** (1 répétition sur 3) | Écart de 9,9 % (146 contre 162 ms), sous le seuil de 20 % ; la condition d'acceptation de A est remplie |
| **H5** (async < 99 % de traces complètes, sync ≥ 99 %) | **Rejetée — provisoire** (1 répétition sur 3) | async : 100 % (1 780 / 1 780) |

---

## S4b — Shipping arrêté 30 s (H3a)

*Répétition 1, 2026-11-08. Charge : 100 cmd/s ; Shipping arrêté 30 s au milieu du run (profil `s4b`, `common/benchmarks/profiles.js`). Traces échantillonnées à 10 % (PC3).*

| Run | Panne (UTC) | Fichiers |
|---|---|---|
| async | 07:54:18 → 07:54:48 | `results/async/s4b/rep-1/` |
| sync | 08:00:57 → 08:01:27 | `results/sync/s4b/rep-1/` |

Les deux runs sont **valides** (aucune itération perdue par k6, panne de 30 s à l'heure prévue).

### Mesures (commandes reçues pendant la panne, phase `fault`)

| Mesure | sync | async |
|---|---|---|
| Commandes | 3 000 | 3 000 |
| Perdues (envoyées par k6, absentes de la base) | 0 | 0 |
| Acceptation p95 | 56 ms | 58 ms |
| Réponse HTTP p95 (k6) | 99 ms | 3 ms |
| Abandons côté client (délai de 5 s) | 2 | 0 |
| Confirmées sans être complétées (ni expédition ni notification) | **2 841** | **0** |
| Complétion p95 (commandes complétées) | 104 ms (≈ 100 commandes seulement, en bord de fenêtre) | 30,2 s (toutes) |
| Fin du drainage | « plus de progression depuis 30 s » : commandes bloquées | toutes les commandes terminées |
| Invariants (tout le run) | I11 violé : 2 967 commandes confirmées jamais complétées | OK |

Sources : `run.json` (validité, panne, k6), `latency.json` (`byPhase.fault`), `invariants.json` de chaque dossier.

### Lecture

1. **Accepter les commandes : aucune différence.** Avec D5 (confirmation dès que le stock est réservé, avant Shipping), les deux variantes acceptent et confirment normalement pendant la panne (acceptation p95 ≈ 57 ms des deux côtés). La formulation de H3 dans l'énoncé (« continuer à **accepter** des commandes ») ne départage pas les styles dans ce scénario.
2. **Terminer les commandes : différence nette.** En async, les demandes d'expédition attendent dans la file de Shipping et sont traitées à son retour : 3 000 commandes sur 3 000 vont au bout (complétion p95 ≈ 30 s, la durée de la panne). En sync, l'appel à Shipping échoue aussitôt et, sans nouvelle tentative, la commande reste confirmée sans expédition ni notification : 2 841 commandes sur 3 000 ne seront jamais complétées (client débité, rien expédié).
3. **Origine de l'écart.** L'async met en file **sans mécanisme ajouté** ; le sync aurait besoin d'**ajouter** un mécanisme (nouvelle tentative, file d'attente) pour obtenir le même résultat. C'est un avantage réel du style, mais il dépend de la règle d'équité « budget de nouvelles tentatives 0 » (AS5) : avec un budget non nul dans les deux variantes (expérience séparée), l'écart serait réduit.

### Verdict

| Hypothèse | Verdict | Justification |
|---|---|---|
| **H3a** (async : ≥ 99 % des commandes de la panne terminées en moins de 2 min après le retour de Shipping) | **Supportée — provisoire** (1 répétition sur 3) | async : 100 % terminées, drainage terminé avant la fin du run (90 s après le retour de Shipping) ; sync : ≈ 3 % complétées. Reste à mesurer précisément le délai après le retour (`max(completed_at)` − fin de panne) et à faire les répétitions 2 et 3. |

---

## S4 — Payment arrêté 30 s (H3b)

*Répétition 1, 2026-11-08. Charge : 100 cmd/s ; Payment arrêté 30 s au milieu du run (profil `s4`). Traces échantillonnées à 10 % (PC3).*

| Run | Panne (UTC) | Fichiers |
|---|---|---|
| sync | 08:16:30 → 08:17:00 | `results/sync/s4/rep-1/` |
| async | 08:25:01 → 08:25:31 | `results/async/s4/rep-1/` |

Les deux runs sont **valides** (aucune itération perdue par k6, panne de 30 s à l'heure prévue).

### Mesures

| Mesure | sync | async |
|---|---|---|
| Commandes reçues pendant la panne (phase `fault`) | 3 000 | 3 000 |
| **Perdues** (envoyées par k6, absentes de la base) | **0** | **0** |
| **Terminées** (`CONFIRMED` ou `REJECTED`) | **24** (premières millisecondes de la fenêtre, avant l'arrêt effectif de Payment) | **3 000** (2 847 confirmées, 88 paiements refusés, 65 stocks insuffisants) |
| **Bloquées** (sans état final après drainage) | **2 976** en `RECEIVED` | **0** |
| Réponse au client pendant la panne (k6, p95) | `502` en 14 ms (3 abandons) | `202` en 4 ms (0 abandon) |
| Acceptation p95 des commandes de la panne | — (jamais acceptées) | 30,4 s (attente du retour de Payment) |
| **Acceptation p95 des commandes reçues après la panne** (phase `after`) | **58 ms** | **5,6 s** |
| Fin du drainage | « plus de progression depuis 30 s » : commandes bloquées | toutes les commandes terminées avant la fin du run |
| Invariants (tout le run) | I10 violé : 3 112 commandes jamais terminées | I9 : 1 violation (artefact de `now()`, `docs/hypotheses-assumption.md` §4) |

Sources : `run.json` (validité, panne, k6, commandes perdues), `latency.json` (`byPhase.fault`, `byPhase.after`), `invariants.json` de chaque dossier.

### Lecture

1. **Pendant la panne**, async **prend en compte** toutes les commandes (`202`) et les termine toutes au retour de Payment ; sync les **refuse** (`502`) et, sans nouvelle tentative (AS5), les laisse bloquées en `RECEIVED` pour toujours. Aucune variante ne perd de commande (chacune est enregistrée avant l'appel à Payment ou l'envoi de l'événement), et aucune ne confirme sans paiement (I1 à I8 respectés des deux côtés).
2. **Coût caché de l'async, après la panne** : les commandes en attente sont traitées dans l'ordre, avant les nouvelles. Les commandes arrivées juste après la panne attendent 5,6 s au p95 (contre 58 ms en sync) : pendant un moment, l'async dépasse le critère p95 < 1 s pour des commandes qui n'ont pas subi la panne. Le redémarrage de Payment à froid (connexions à la base, C2) contribue aussi.
3. **Compromis** : l'async sauve les commandes de la panne, au prix d'un ralentissement temporaire des suivantes ; le sync reste rapide pour la suite, au prix de commandes abandonnées pour le client (erreur `502`, commande bloquée). Ce compromis n'entre pas dans le verdict de H3b ; il doit figurer dans l'ADR (*Trade-offs*).
4. Comme en S4b, l'écart dépend de la règle « budget de nouvelles tentatives 0 » : le sync aurait besoin d'un mécanisme ajouté pour rattraper les commandes de la panne.

### Verdict

| Hypothèse | Verdict | Justification |
|---|---|---|
| **H3b** (async : 0 perdue et ≥ 99 % des commandes de la panne dans un état final moins de 2 min après le retour de Payment) | **Supportée — provisoire** (1 répétition sur 3) | async : 0 perdue, 3 000 / 3 000 en état final, drainage terminé avant la fin du run (90 s après le retour de Payment) ; sync : 2 976 bloquées sur 3 000. Reste à mesurer précisément le délai après le retour et à faire les répétitions 2 et 3. |

---

## S3 — Payment lent : 2 s pendant 60 s (H3c)

*Répétition 1, 2026-11-08. Charge : 100 cmd/s ; latence de Payment portée à 2 s pendant 60 s au milieu du run par `POST /admin/chaos` (profil `s3`), sonde `GET /orders/:id` une fois par seconde. Délai client de 5 s (PC2), VUs préparés d'avance (PC6). Traces échantillonnées à 10 % (PC3).*

| Run | Lenteur (UTC) | Écart à l'heure prévue (pose / levée) | Fichiers |
|---|---|---|---|
| sync | voir `run.json` (`faultTiming`) | 10 ms / 8 ms | `results/sync/s3/rep-1/` |
| async | 09:08:43 → 09:09:43 | voir `run.json` (`faultTiming`) | `results/async/s3/rep-1/` |

Les deux runs sont **valides** (aucune itération perdue par k6, lenteur de 60 s à l'heure prévue).

### Mesures (phase `fault`, sauf mention)

| Mesure | sync | async |
|---|---|---|
| Requêtes envoyées par k6 | 5 989 | 6 000 |
| **Abandons côté client** (sans réponse en 5 s) | **5 247 (87,6 %)** | **0** |
| **Réponse HTTP p95** (k6) | **5 002 ms** (le délai client) | **3 ms** |
| Sonde `GET /orders/:id` p95 | 3 ms | 1,6 ms |
| Commandes allées au bout (état final) | **625** (≈ 10 acceptées par seconde) | **6 000** |
| Commandes bloquées pour toujours | **5 364** (`RECEIVED`) | **0** |
| Perdues (absentes de la base) | 0 | 0 |
| Acceptation p95 | 4,7 s (sur les 625 acceptées) | **39,8 s** (toutes, en attente dans la file) |
| Acceptation p95 des commandes reçues **après** la lenteur (phase `after`) | **176 ms** | **7,5 s** |
| Invariants (tout le run) | I10 : 5 364 commandes jamais terminées | I9 : 2 (artefact de `now()`, `docs/hypotheses-assumption.md` §4) |

Sources : `run.json` (validité, `faultTiming`, k6 par phase), `latency.json` (`byPhase.fault`, `byPhase.after`), `invariants.json` de chaque dossier.

### Lecture

1. **La différence n'est pas le débit, c'est qui subit l'attente.** Avec Payment à 2 s et au plus 64 traitements en parallèle, la capacité de Payment est d'environ 32 commandes par seconde dans les deux variantes, pour 100 reçues. En **sync**, c'est le **client** qui attend : 87,6 % des requêtes dépassent 5 s et presque toutes les commandes de la fenêtre restent bloquées (Order abandonne aussi ses appels à Payment au bout de 5 s, attente d'une connexion libre comprise). En **async**, c'est la **file** qui attend : le client a sa réponse en 3 ms, et toutes les commandes aboutissent, environ 40 s plus tard.
2. **Le sync gaspille la capacité de Payment** : ≈ 10 commandes acceptées par seconde au lieu de ≈ 32 possibles, car beaucoup d'appels attendent une connexion libre puis expirent sans avoir servi. L'async utilise toute la capacité et rattrape tout.
3. **Même compromis qu'en S4** : après la lenteur, le sync repart aussitôt (176 ms), l'async fait attendre les commandes suivantes derrière sa file (7,5 s au p95, au-delà du critère de 1 s).
4. **Les lectures ne sont gênées dans aucune variante** (sonde à quelques millisecondes) : Order n'est pas saturé en CPU, l'attente est ailleurs (connexions vers Payment en sync, file en async).

### Verdict

| Hypothèse | Verdict | Justification |
|---|---|---|
| **H3c** (async : réponse HTTP p95 < 200 ms et 0 abandon ; sync : plus de 50 % d'abandons) | **Supportée — provisoire** (1 répétition sur 3) | async : 3 ms et 0 abandon ; sync : 87,6 % d'abandons. Compromis hors verdict : acceptation à ≈ 40 s pendant la lenteur et 7,5 s juste après en async. |

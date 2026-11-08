# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> POC « Communication synchrone et asynchrone » (traitement des commandes). Contenu issu de `instruction.md` (2026-11-02).
> Là où ce fichier dit « par défaut », la valeur est une proposition de conception ; **si le code du dépôt dit autre chose, le code fait foi : signale l'écart plutôt que de le corriger en silence.**

## 1. But du projet

Expérience architecturale limitée (pas la plateforme finale) qui compare deux façons de traiter une commande e-commerce :

- **`sync/`** : workflow synchrone, Order appelle successivement Payment → Inventory → Shipping → Notification en REST.
- **`async/`** : workflow orienté événements via RabbitMQ (chorégraphie).

Elle doit permettre de recommander à un Architecture Review Board : `ADOPT SYNCHRONOUS`, `ADOPT EVENT-DRIVEN`, `ADOPT HYBRID ARCHITECTURE` ou `NO DECISION — additional evidence required`. Ce qui compte : la chaîne **preuve → raisonnement → décision**, pas le choix lui-même. La direction technique refuse d'adopter l'événementiel « parce que plus scalable » : elle veut des preuves.

Livrable terminal : mise à jour de `docs/ADR-001.md` (Status, Context, Architectural drivers, Options considered, Candidate decision, Evidence collected, Experimental results, Trade-offs, Limitations, Final decision, Consequences).

## 2. État d'avancement

**Annoncé (par le responsable)** : étapes 1 à 6 (socle, `sync/`, vérification d'invariant, `async/`, parité, traces) terminées ; étape en cours : **étape 7**, scénarios S1 à S5 (procédure : `poc-communication-etape7.md`).

**Constaté dans le dépôt au 2026-11-07** (le code fait foi) : étapes 1 à 6 faites et vérifiées (socle, `sync/`, vérification d'invariants, `async/`, parité, traces) ; étape 7 à faire. Ne présume pas que le reste est fait ; revérifie avant chaque étape et mets cette liste à jour.

Présent :
- `package.json` + lockfile dans `sync/`, `async/`, `common/` (ESM, Node >= 22, `.nvmrc` = 22), dépendances installées.
- `common/infra/` : `docker-compose.yml` (projet `poc-obs` : Jaeger, OTel Collector, Prometheus, Grafana sur le réseau externe `poc-net`), `otel-collector.yml` (traces seulement → Jaeger), `prometheus.yml` (cibles `order:3000` … `notification:3004`, `rabbitmq:15692`). Vérifié le 2026-11-02 : les 4 conteneurs `poc-obs` tournent sur `poc-net` et répondent (Jaeger, Prometheus, Grafana, Collector OTLP) ; les cibles Prometheus sont `down` faute de services.
- `common/db/` : `schema.sql` (10 tables), `seed.sql` (réexécutable), `postgres.compose.yml` (PostgreSQL 17.11 figé, inclus par `sync/docker-compose.yml`, port hôte 55432, user/mdp/base `poc`). Vérifié le 2026-11-02 : chargement, rejeu idempotent, requête d'invariant.
- `sync/` (étape 2, vérifiée le 2026-11-02) : les 5 services (`lib/`, `services/*/{domain,server}.js`, `services/order/workflow.js`), `Dockerfile`, `docker-compose.yml` (projet `poc-sync`, image construite par `payment` puis réutilisée), `npm test` (12 tests `node:test` sur `domain.js`). Parcours vérifiés à la main : confirmée, paiement refusé, stock insuffisant avec void, requêtes invalides, panne d'Inventory (`502`, commande bloquée `ACCEPTED`). Prometheus voit les 5 cibles `up`, Jaeger reçoit des traces propagées entre services avec les requêtes pg.
- `docs/invariants.md` : I1 (énoncé) et règles dérivées I2–I11 (propositions).
- `common/` (étape 3, vérifiée le 2026-11-03) : `scripts/reset.js` (`npm run reset`), `scripts/verify-invariants.js` + `scripts/invariants.js` (`npm run verify [-- --out <fichier>]`, codes 0/1/2), `test/invariants.test.js` (`npm test`, 14 tests, une violation injectée par règle, en transaction annulée). Colonne `products.initial_stock` ajoutée (I6) ; une base créée avant doit être remise à zéro avec `npm run reset`.
- Charge et mesure (2026-11-07) : `common/benchmarks/place-order.js` (k6 `grafana/k6:2.3.0` figé, modèle ouvert `constant-arrival-rate`, mélange D12, `RUN_ID` en préfixe des `customerId`), `common/scripts/latency.js` (statuts, débit, p50/p95/p99 d'acceptation, confirmation, complétion depuis la base), Prometheus en remote write (k6 `-o experimental-prometheus-rw`, étiquette `testid`), tableau Grafana « POC — Run k6 et services ». Commande complète : README. Essai à blanc `dry-sync-01` (100 cmd/s, 1 min, non cité dans l'ADR) : valide, invariants OK, p95 d'acceptation 72 ms ; les 10 premières secondes sont 3× plus lentes (connexions froides, C2) : préchauffage indispensable.
- `async/` (étape 4, vérifiée le 2026-11-07, V1–V16 de `docs/async-mise-en-place.md`) : RabbitMQ 4.3.6 figé (topologie déclarée par `async/rabbitmq/definitions.json`, 2 CPU / 1 Go), `lib/` (`broker.js` confirmations + `prefetch` 64 + `noDelay`, `outbox.js` publication après commit + balayage de secours non tracé, `consumer.js` idempotence `processed_events` + budget 0 vers DLQ, `service.js`), 5 services (copies identiques des `domain.js`, `services/order/handlers.js` « noter le fait, puis décider »), `POST /orders` → `202`, `npm test` (5 tests). Vérifié : parcours, compensation, panne de Payment (commandes terminées au redémarrage), doublon ignoré, outbox vide et DLQ vides après drainage, trace unique à travers les 5 services, `verify` OK, essai à blanc `dry-async-01` (100 cmd/s, p95 d'acceptation 125 ms), `reset` qui purge les files. `async/` a sa propre base (volume distinct de `sync/`).
- Parité (étape 5, vérifiée le 2026-11-07) : `common/scripts/check-parity.js` (`cd common && npm run parity [-- --out <fichier>]`, codes 0/1/2) compare l'empreinte SHA-256 des cinq `domain.js` et la configuration Compose (cpus, mem_limit, `PG_POOL_MAX`, `LOG_LEVEL`, `SIMULATED_LATENCY_MS`, `PREFETCH` async = `OUTBOUND_CONNECTIONS` sync) ; 7 tests dans `common/test/parity.test.js`. État au 2026-11-07 : parité respectée (5 fichiers identiques, 30/30 contrôles de configuration).
- Traces (étape 6, vérifiée le 2026-11-07 dans les deux variantes) : spans HTTP serveur nommés par la route (`POST /orders`, `GET /orders/:id`, attribut `http.route`) ; attribut `order.id` sur la requête HTTP de chaque service (sync) et sur chaque traitement d'événement (async, avec `event.type`), pour retrouver la trace d'une commande (Jaeger : Tags `order.id=<uuid>`) ; `/health` et `/metrics` ne sont plus tracés (C-1) ; log `order received` (orderId + traceId) en async. Les spans HTTP client de `sync/` restent nommés `POST` (convention OpenTelemetry). `@opentelemetry/api` ajoutée à `sync/`.
- `docs/resultats.md` : résultats mesurés par scénario, avec les fichiers de `results/` et les verdicts (provisoires tant qu'il n'y a pas trois répétitions). Au 2026-11-08 : S1 (exigence S1 respectée par A et B ; H2 et H5 rejetées, provisoire) S4 (H3b supportée, provisoire ; compromis : async ralentit les commandes qui suivent la panne) et S4b (H3a supportée, provisoire).
- `docs/async-mise-en-place.md` : conception validée (AS1–AS11), plan, étapes de validation V1–V16 et constats de mise en œuvre.
- `docs/ADR-001.md` : version initiale (2026-11-07), décision candidate ADOPT EVENT-DRIVEN, figée ; sections finales vides.
- `docs/decisions-conception.md` : décisions DB1–DB12 (base), SV1–SV13 (services synchrones), VI1–VI7 (vérification des invariants), avec leur source.

Absent (dossiers vides ou fichiers manquants) :
- la CLI `poc` ;
- `common/scripts/run-scenario.js` ; la forme définitive de S2 (D8, D13 ; k6 a déjà les profils `constant` et `steps`) ;
- PoC Plan, Architecture Analysis, matrice de décision (les hypothèses et la traçabilité sont dans `docs/hypotheses-assumption.md`) ;
- `poc-communication-etape7.md` ;
- les crochets de l'étape 7 : `POST /admin/chaos`, `Idempotency-Key`, métriques métier ; le script de mesure de la part de traces complètes (H5).

**Défaut de mesure corrigé (2026-11-03)** : `received_at` était écrit à l'INSERT (`now()`), après l'attente du pool et la lecture des prix. Il vaut désormais l'instant d'arrivée de la requête (hook `onRequest` de `POST /orders`), passé à `createOrder`, qui l'exige. `async/` doit faire de même côté transport. Détail : `docs/cas-de-comprehension.md`, C3.

**Défaut de mesure connu, non corrigé (2026-11-08)** : `now()` (début de transaction) au lieu de `clock_timestamp()` pour `accepted_at`/`confirmed_at`/`rejected_at`/`completed_at` dans le `domain.js` d'Order ; en async, deux événements concurrents peuvent donner `confirmed_at < accepted_at` (I9). Détail et correction proposée : `docs/hypotheses-assumption.md` §4 (définition des latences).

Les crochets de l'étape 7 (section 8) n'existent donc pas encore. Dans la section 9, fonctionnent : les deux premières commandes, `docker compose up -d --build` dans `sync/` et `async/`, `reset.js` et `verify-invariants.js`.

Autres écarts :
- Le dépôt s'appelle `poc-projet-01`, pas `poc-communication`.
- Les images de `common/infra/docker-compose.yml` sont figées (tag + digest) depuis le 2026-11-02 : Jaeger 1.76.0, Collector contrib 0.164.0, Prometheus v3.15.1, Grafana 13.3.0. Ne pas revenir à `:latest`. Jaeger v1 est déprécié (successeur : `jaegertracing/jaeger` v2) ; une migration changerait l'outillage entre runs, à faire avant les mesures ou pas du tout. Jaeger est plafonné à 5 000 traces en mémoire et 1,5 Go depuis le 2026-11-07 (C-2 ; il avait été tué faute de mémoire, M4 et M9 de `docs/async-mise-en-place.md`).
- Grafana est configuré par fichiers (`common/infra/grafana/provisioning/`) : sources `Prometheus` (uid `prometheus`, par défaut) et `Jaeger` (uid `jaeger`) ; tout JSON déposé dans `common/infra/grafana/dashboards/` est chargé dans le dossier « POC ». Grafana n'a pas de volume de données : ce qui est fait dans l'interface est perdu à la recréation du conteneur, donc tout tableau de bord doit vivre en JSON dans le dépôt (exporté depuis l'UI si besoin).

## 3. Structure

```
poc-projet-01/
├─ sync/      # projet A autonome : package.json, docker-compose.yml, poc (CLI), lib/, services/{order,payment,inventory,shipping,notification}
├─ async/     # projet B autonome : idem + outbox, adaptateur broker, consommateurs
├─ common/    # HORS comparaison : db/ (schema, seed), benchmarks/ (k6), scripts/, infra/ (observabilité)
├─ docs/      # ADR-001, hypothèses, traçabilité, matrice de décision
└─ results/   # sorties des runs (non versionné)
```

Règles de structure :

- `sync/` et `async/` sont **deux projets distincts** : aucune dépendance de l'un vers l'autre. Un seul `package.json` par projet (pas de sous-paquets par service).
- Le code **comparé** (transport) vit dans chaque projet. Ce qui n'est pas comparé (schéma, k6, vérification, rapport, observabilité) vit dans `common/`.
- Le `domain.js` de chaque service existe en **deux copies** (une par projet). `common/scripts/check-parity.js` compare leurs empreintes. **Ne modifie jamais un `domain.js` d'un côté sans le faire de l'autre**, sauf divergence voulue, à documenter dans l'ADR.
- Un seul projet actif à la fois (mêmes ports, noms Compose `poc-sync`, `poc-async`, `poc-obs`).

## 4. Stack

Node.js 22 en JavaScript ESM ; Fastify ; `pg` en SQL explicite (pas d'ORM) ; `undici` (appels sync) ; `amqplib` + RabbitMQ (async) ; PostgreSQL 17 ; OpenTelemetry → Collector → Jaeger ; `prom-client` → Prometheus → Grafana ; `pino` (logs JSON avec `orderId` et `traceId`) ; k6 pour la charge ; Docker Compose ; `node:test` pour les tests.

Pas de TypeScript sauf demande explicite. Pas d'ORM. N'ajoute pas de dépendance sans la justifier.

## 5. Domaine et invariant

Scénario unique : **Place Order**. Requête minimale : `customerId`, `items[]`, `quantity`, `paymentInformation`, `shippingAddress`.

États : `RECEIVED → ACCEPTED (paiement autorisé) → CONFIRMED (stock réservé)`, ou `REJECTED` (paiement refusé / stock insuffisant, avec compensation).

- **Acceptée** = paiement passé (précision du responsable). **Confirmée** = transaction sur Order.
- **Invariant non négociable** : une commande ne peut être confirmée que si le paiement est autorisé **et** le stock réservé. Il est appliqué en **un seul point**, par la même requête dans A et B :

```sql
UPDATE orders SET status='CONFIRMED', confirmed_at=now()
 WHERE id=$1 AND status='ACCEPTED'
   AND payment_status='AUTHORIZED' AND stock_status='RESERVED';
```

- Stock insuffisant **après** paiement autorisé : le paiement doit être annulé (`void`). C'est une compensation, à implémenter dans les deux variantes.
- Payment est un **simulateur** (autorisé ou refusé), pas un vrai fournisseur.
- **Par défaut (D5)** : la confirmation survient dès que le stock est réservé ; Shipping et Notification viennent après. Écart avec l'énoncé (où `OrderConfirmed` suit `ShipmentRequested`), à appliquer à l'identique dans A et B.

## 6. Règles d'équité de la comparaison

La comparaison n'est valable que si seul le **style** diffère. Donc :

- Même schéma SQL, mêmes colonnes d'horodatage (`received_at`, `accepted_at`, `confirmed_at`, `completed_at`), mêmes latences simulées, mêmes limites de ressources (1 CPU / 512 Mo par service), même charge k6, même budget de retries.
- Les latences se calculent **depuis la base**, avec les mêmes requêtes pour A et B. Latence d'acceptation = `accepted_at − received_at` (critère p95 < 1 s, précision du responsable du 2026-10-27) ; confirmation ; complétion. Ne compare jamais le p95 d'acceptation d'une variante au p95 de complétion de l'autre.
- Pas de circuit breaker ni de mécanisme de résilience ajouté à une variante seulement : cela fausserait la comparaison. Toute amélioration de résilience est une expérience distincte, à documenter.
- Sous Node, il n'y a pas de thread par requête : l'indicateur « threads/connexions » se lit comme requêtes en vol, sockets occupés, attente dans le pool sortant et retard de la boucle d'événements.

## 7. Variante async : points de conception

- Échange `topic` `orders`, une file durable par consommateur, `prefetch` borné, DLQ après N redélivraisons.
- Enveloppe d'événement : `{ eventId, type, orderId, occurredAt, payload }`, plus `traceparent` dans les en-têtes AMQP.
- **Outbox transactionnel** (par défaut, D3) : commande et ligne d'outbox dans la même transaction ; un relais publie avec confirmation d'éditeur.
- **Idempotence des consommateurs** : `processed_events(consumer, event_id)` avec contrainte unique, dans la même transaction que l'effet métier.
- `POST /orders` renvoie `202` ; « acceptée » se mesure par horodatage (par défaut, D4).

## 8. Étape 7 : crochets attendus dans le code

Vérifie leur présence avant de lancer un scénario :

- `POST /admin/chaos` (`latencyMs`, `failRate`) sur Payment, dans les deux projets.
- Variables `DUPLICATE_DELIVERY=2` et `IDEMPOTENCY=on|off` dans `async/`.
- `Idempotency-Key` et retry client dans `sync/` (pour que S5 soit symétrique).
- `GET /orders/:id` dans les deux projets.
- Métriques : `order_stage_duration_seconds{stage}`, `inflight_requests`, `eventloop_lag_seconds`, `outbound_pool_pending{target}`, `consumer_redelivered_total`, `retries_total`, `duplicates_detected_total`, `side_effects_duplicated_total`.
- `common/db/seed.sql` et `common/scripts/reset.js` (remise à zéro avant chaque run, purge des files RabbitMQ pour `async/`).

Scénarios (durées et formes à confirmer, voir D8) :

| ID | Charge | Action |
|---|---|---|
| S1 | 100 cmd/s constant | aucune |
| S2 | montée progressive jusqu'à 500 cmd/s, puis 5 min à 500 | aucune |
| S3 | 100 cmd/s | Payment à 2 s pendant une fenêtre, avec sonde `GET /orders/:id` |
| S4 | 100 cmd/s | `docker compose stop payment` pendant 30 s puis redémarrage |
| S4b | 100 cmd/s | `docker compose stop shipping` pendant 30 s puis redémarrage (ajouté le 2026-11-07 pour H3a : service secondaire) |
| S5 | faible débit | événement dupliqué ×2, idempotence activée puis désactivée (témoin) |

Protocole de run : un seul projet actif → reset + seed → préchauffage non compté → scénario → **attendre le drainage** → `verify-invariants.js` → extraction des latences SQL → métriques Prometheus → trois répétitions en alternant l'ordre des projets. Sorties dans `results/<projet>/<scénario>/rep-<n>/`.

Règles de validité :

- Trop d'itérations perdues (`dropped_iterations` ≥ 1 %, par défaut) : run **invalide**, à refaire.
- Une violation d'invariant est un **résultat à documenter**, pas un run à jeter.
- Une mesure manquante donne un verdict `inconclusive`, jamais un succès implicite.
- Un refus de paiement ou un stock insuffisant voulus sont des issues métier (`REJECTED`), pas des erreurs techniques.

## 9. Commandes utiles

```bash
docker network create poc-net                         # une seule fois
docker compose -f common/infra/docker-compose.yml up -d   # observabilité
cd sync  && docker compose up -d --build              # ou async
node common/scripts/reset.js
node common/scripts/verify-invariants.js
node common/scripts/run-scenario.js --project sync --scenario s1 --rep 1
node common/scripts/check-parity.js
```

k6 n'est pas installé sur la machine de développement : l'exécuter via Docker sur `poc-net` (`grafana/k6`, cible `http://order:3000` passée par `-e TARGET`).

## 10. Conventions de travail

- **Suis la méthodologie de `docs/methodologie.md`** : faire le point, expliquer et discuter la conception, n'écrire du code qu'après accord, vérifier, expliquer comment tester, documenter, commiter/pousser sur demande.
- Réponds en **français** ; le code, les identifiants et les noms de métriques restent en anglais.
- Documente la compréhension : quand tu prends une décision de conception, note-la dans `docs/` (ADR ou fichier dédié) en distinguant **ce qui vient de l'énoncé**, **ce que le responsable a décidé**, et **ce que tu proposes**.
- Ne présente jamais un résultat comme mesuré s'il ne l'a pas été. Cite le fichier de `results/` qui le prouve.
- Ne remplis pas la matrice de décision par des opinions : chaque cellule cite un résultat.
- Les scripts doivent être idempotents quand c'est possible (reset, seed) et ne jamais supprimer `results/` sans demande.
- Ne modifie pas `docs/ADR-001.md` « Candidate decision » après coup : c'est l'intuition de départ, volontairement figée avant les preuves.
- Avant tout changement dans un `domain.js`, applique la règle de parité (section 3).

## 11. Décisions encore ouvertes

| # | Question | Valeur par défaut |
|---|---|---|
| D4 | Réponse initiale en B | `202` sur « reçue », « acceptée » mesurée par horodatage |
| D5 | Où se place la confirmation | Dès `InventoryReserved`. **Conservée sur `main`** (2026-11-07, responsable du POC). Le workflow de l'énoncé (confirmation après `ShipmentRequested`) sera testé plus tard sur la branche `experiment/workflow-enonce` : colonne `orders.shipping_status`, condition `shipping_status='REQUESTED'` ajoutée à la requête de confirmation, panne de Shipping qui laisse la commande `ACCEPTED`, I8 et I11 reformulés, même changement dans `sync/` et `async/`. |
| D8 | Durée de S1, forme du pic de S2 | **Tranchée le 2026-11-07** (responsable du POC). Préchauffage non compté de 1 min à 50 cmd/s dans les deux. **S1** : 3 min à 100 cmd/s. **S2** : paliers de 1 min à 100, 200, 300, 400 cmd/s (lecture de la dégradation, hors verdict), puis **palier de 5 min à 500 cmd/s** (fenêtre du verdict de H1). Drainage jusqu'à ce que toutes les commandes soient terminées, plafonné à 10 min. Seules les commandes reçues (`received_at`) pendant la fenêtre de mesure sont comptées. |
| D12 | Mélange de charge | 3 % de paiements refusés, 2 % sur `SKU-LOW` |
| D13 | Plafond de VUs k6 au-delà de la saturation (S2) | **Tranchée le 2026-11-07** (responsable du POC) : **délai maximal côté client de 5 s** (k6 abandonne la requête et la compte en échec), identique pour sync/ et async/, plafond de 3 000 VUs (500 cmd/s × 5 s = 2 500 requêtes en vol au plus). La règle « ≥ 1 % d'itérations perdues = run invalide » est conservée : elle signale désormais une limite de k6, pas du système. Les abandons côté client sont rapportés en plus ; le verdict reste lu en base. Détail : `docs/decisions-conception.md`, PC2. |
| D15 | Échantillonnage des traces pendant les runs de charge | **Tranchée le 2026-11-07** (responsable du POC, option B) : 100 % par défaut (vérifications, cas de compréhension, S5) ; **10 % pendant S1 à S4**, identique pour sync/ et async/ (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`), ajouté au contrôle de parité. H5 se mesure sur les commandes échantillonnées. Essai de calibrage prévu pour mesurer le coût de l'instrumentation. Détail : `docs/decisions-conception.md`, PC3. |
| D14 | Ordre d'arrivée des événements chez Order (`async/`) | « Noter le fait, puis décider » (validé le 2026-11-07) : chaque événement enregistre son fait, puis Order tente la décision (confirmer ou rejeter pour stock insuffisant) ; le second arrivé décide. Demande `markStockInsufficient` et la condition `stock_status='INSUFFICIENT'` dans le rejet, dans les deux `domain.js`. |

Si une de ces décisions a été tranchée depuis, mets ce tableau à jour plutôt que de t'y fier.

## 12. Problème, assumptions et hypothèses

**La référence est `docs/hypotheses-assumption.md`** (problème, incertitude, assumptions A-01–A-30, questions Q-01–Q-07, hypothèses avec mesure et seuil, traçabilité métrique → hypothèse, verdicts, menaces à la validité). Ne te fie pas à un résumé : relis ce fichier avant de concevoir une mesure ou un scénario.

Repères (restructuration du 2026-11-07) :
- **Assumption centrale** : l'événementiel est plus scalable que le synchrone. Elle est mise à l'épreuve par **H1** (S2, 500 cmd/s : débit accepté ≥ 95 % du débit offert, p95 d'acceptation < 1 s, 0 violation de I1), seuils validés par le responsable du POC.
- **H2** (latence de complétion, S1) : formulation et seuils validés le 2026-11-07 (écart ≥ 20 %, acceptation p95 < 1 s).
- **H3a** (panne de Shipping, scénario **S4b**) : gardée, seuils validés le 2026-11-07 (30 s, ≥ 99 % terminées en moins de 2 min).
- **H3b** (Payment indisponible, S4) : gardée, seuils validés le 2026-11-07 (0 perdue, ≥ 99 % en état final en moins de 2 min ; états perdue / bloquée / terminée).
- **H3c** (Payment lent, S3) : reformulée et validée le 2026-11-07 (fenêtre de 60 s à 2 s ; B : réponse HTTP p95 < 200 ms et 0 abandon ; A : > 50 % d'abandons au délai client de 5 s).
- **H4** (coût de l'idempotence, S5) : validée le 2026-11-07 (I7 = 0, I1 = 0, surcoût des doublons < 10 % ; coût du mécanisme et inventaire de complexité rapportés à part ; **S5 symétrique** : `Idempotency-Key` et requête envoyée deux fois côté sync, mesure « commandes en double par requête client »).
- **H5** (part de traces complètes) : validée le 2026-11-07 (seuil 99 %, trace complète définie par état final, mesure sur les commandes échantillonnées juste après le run, effort d'instrumentation rapporté à part).
- Autres hypothèses, seuils encore **à valider** : H6 (hybride, brouillon en attente de Q-02 : troisième variante mesurée ou déduction).
- Les hypothèses, seuils et critères de verdict se fixent **avant** toute mesure ; un seuil ne se modifie pas après avoir vu les résultats.

Chaque métrique doit répondre à : **quelle hypothèse permet-elle d'évaluer ?** Une métrique de diagnostic explique un verdict, elle ne décide rien.

## 13. Limites à garder à l'esprit

Services simulés (latences et pannes injectées) ; un seul hôte (k6, base, broker, services, monitoring se partagent les ressources) ; PostgreSQL commun pouvant masquer l'effet du style ; résultats dépendants de la configuration RabbitMQ (conclure sur le style, pas sur le broker) ; Node mono-processus par service ; chorégraphie plutôt qu'orchestration en B. Conclure sur **ce rig**, pas sur « le synchrone » ou « l'événementiel » en général.
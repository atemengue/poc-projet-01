# Mise en place de la variante asynchrone (étape 4)

> Conception discutée et validée point par point le 2026-11-07, avant tout code (méthodologie : `docs/methodologie.md`).
> Sources : **Énoncé**, **Responsable** (décision du responsable du POC), **Proposition** (proposée par Claude). « Validée » = acceptée par le responsable le 2026-11-07.
> Implémenté et vérifié le 2026-11-07 (V1 à V16 passées, §7).

## 1. Point de départ

| Élément | État |
|---|---|
| `async/package.json` | Dépendances installées (`amqplib` 2.2.1 + même pile que `sync/`) ; `lib/` et `services/` vides |
| Schéma | `outbox` et `processed_events` existent déjà (`common/db/schema.sql`), inutilisées |
| Prometheus | Cible `rabbitmq:15692` déjà déclarée |
| Domaine | Les cinq `domain.js` de `sync/` sont copiés à l'identique (règle de parité) |
| Workflow | **D5 conservée** : confirmation dès que le stock est réservé, avant Shipping. Le workflow de l'énoncé (confirmation après `ShipmentRequested`) sera testé sur la branche `experiment/workflow-enonce` |
| Préalables faits | ADR-001 initial (décision candidate figée), `sync/` vérifié sur la pile avec la requête de l'énoncé, essais à blanc `dry-sync-01` et `dry-sync-02` |

## 2. Décisions validées

| # | Point | Décision | Source |
|---|---|---|---|
| AS1 | Rôle du « gestionnaire d'événements » | **RabbitMQ** (le broker). Pas d'orchestrateur central : chorégraphie, comme dans l'énoncé (A-16). | Responsable |
| AS2 | Chaîne d'événements | Voir §3. Les données utiles voyagent dans les événements : aucun service ne lit les tables d'un autre. | Proposition validée |
| AS3 | Compensation | Stock insuffisant → Order publie `OrderRejected` → Payment annule (`void`, tous les paiements autorisés de la commande, SV9) → `PaymentVoided` → Order. Notification réagit à `OrderRejected` en parallèle de l'annulation (en `sync/`, elle suit l'annulation : différence propre au style, à documenter). | Énoncé (compensation) + Proposition validée |
| AS4 | Ordre d'arrivée chez Order (D14) | **Noter le fait, puis décider** : chaque événement enregistre son fait (`ACCEPTED`, `stock_status`), puis Order tente la décision (confirmer, ou rejeter pour stock insuffisant) ; le second arrivé décide. Ajoute `markStockInsufficient` et la condition `stock_status='INSUFFICIENT'` au rejet, **dans les deux `domain.js`** (sync appelle les deux fonctions à la suite : comportement inchangé). | Proposition validée |
| AS5 | Budget de nouvelles tentatives | **0 des deux côtés.** Une erreur de traitement envoie le message directement en DLQ. Ne sont pas des nouvelles tentatives : l'attente dans la file quand un service est arrêté (propriété du style, mesurée par H3b), la remise en file d'un message non acquitté après un plantage (garantie « au moins une fois »), la republication par le relais de l'outbox. Expérience séparée possible plus tard : même budget non nul dans les deux variantes. | Énoncé (équité) + Responsable |
| AS6 | `prefetch` | **64 par consommateur**, égal à `OUTBOUND_CONNECTIONS` de `sync/` (concurrence maximale reçue par un service), passé par une seule variable commune. Pool `pg` de 20 inchangé. | Proposition validée |
| AS7 | Relais de l'outbox | **Option C** : chaque service publie lui-même, juste après le commit, les événements qu'il vient d'écrire (avec confirmation du broker, puis `published_at`) ; un balayage de secours toutes les secondes republie les lignes restées non publiées (`FOR UPDATE SKIP LOCKED`). Évite d'ajouter un délai d'interrogation à chacun des 6 événements d'une commande. | Proposition validée |
| AS8 | RabbitMQ | Image `rabbitmq` 4.x avec administration, figée (tag + empreinte). Échange `topic` `orders` ; une file durable classique par service consommateur ; échange `orders.dlx` et une file `<service>.dlq` par service ; messages persistants ; confirmations de publication ; acquittement manuel après le commit. **2 CPU / 1 Go** (comme PostgreSQL), comptés dans les ressources d'`async/`. Le ralentissement des éditeurs au-delà du seuil mémoire est un comportement à observer (S2, S4), pas un défaut. | Proposition validée |
| AS9 | Propagation de la trace | Le `traceparent` courant est enregistré dans `outbox.headers` à l'écriture ; à la publication, le contexte est restauré depuis ces en-têtes, puis l'instrumentation `amqplib` d'OpenTelemetry l'injecte dans le message et le relit à la réception. Une trace par commande à travers les cinq services, avec le temps passé en file. | Énoncé (§9) + Proposition validée |
| AS10 | Réponse HTTP | `POST /orders` répond **`202`** après l'enregistrement de la commande et de `OrderCreated` (D4) ; `received_at` est noté à l'arrivée de la requête (hook `onRequest`, cas C3). `GET /orders/:id` comme en `sync/`. | Énoncé + D4 + SV13 |
| AS11 | Enveloppe d'événement | `{ eventId, type, orderId, occurredAt, payload }`, `traceparent` dans les en-têtes AMQP ; `eventId` = `outbox.id`, clé d'idempotence (`processed_events`). | `CLAUDE.md` §7 |

## 3. Chaîne d'événements (AS2, avec D5)

```
POST /orders → Order : RECEIVED + OrderCreated (même transaction) → 202

OrderCreated          → Payment      : paiement → PaymentAuthorized | PaymentDeclined
PaymentAuthorized     → Order        : ACCEPTED, puis tente la décision
                      → Inventory    : réservation → InventoryReserved | InventoryInsufficient
InventoryReserved     → Order        : stock RESERVED, puis tente de confirmer → CONFIRMED + OrderConfirmed
OrderConfirmed        → Shipping     : expédition → ShipmentRequested
ShipmentRequested     → Notification : ORDER_CONFIRMED → NotificationSent
NotificationSent      → Order        : completed

PaymentDeclined       → Order        : REJECTED (PAYMENT_DECLINED) + OrderRejected
InventoryInsufficient → Order        : stock INSUFFICIENT, puis tente de rejeter → REJECTED (INSUFFICIENT_STOCK) + OrderRejected
OrderRejected         → Payment      : si INSUFFICIENT_STOCK, void → PaymentVoided
                      → Notification : ORDER_REJECTED
PaymentVoided         → Order        : payment_status VOIDED
```

Écart avec l'énoncé (`… → ShipmentRequested → OrderConfirmed`) : D5, appliquée à l'identique dans `sync/` et `async/`.

Chaque consommateur, dans **une seule transaction** : insertion dans `processed_events` (si déjà présent : doublon, on acquitte sans rien faire), effet métier via `domain.js`, écriture des événements suivants dans `outbox`. Acquittement du message après le commit, puis publication des nouveaux événements (AS7).

## 4. Hors périmètre de l'étape 4

| Élément | Étape |
|---|---|
| `common/scripts/check-parity.js` | 5 |
| Noms de route dans les spans HTTP | 6 |
| `POST /admin/chaos`, `DUPLICATE_DELIVERY`, `IDEMPOTENCY=off`, métriques métier, `Idempotency-Key` côté `sync/` | 7 |
| Variante hybride (H6, Q-02) | à décider |
| Workflow de l'énoncé sans D5 | branche `experiment/workflow-enonce` |
| Plafond de VUs k6 au-delà de la saturation (D13) | avant S2 |

## 5. Plan d'implémentation

Deux temps, avec une vérification entre les deux.

**Temps 1 — socle**
1. D14 dans les deux `domain.js` d'Order (`markStockInsufficient`, condition du rejet) ; tests `sync/` toujours verts ; `sync/` revérifié (stock insuffisant).
2. `async/lib/` : reprise de `sync/lib/` (télémétrie, logs, base, serveur), plus `broker.js` (connexion, topologie, publication confirmée), `outbox.js` (écriture avec `traceparent`, publication après commit, balayage de secours), `consumer.js` (idempotence, transaction, acquittement, DLQ).
3. RabbitMQ dans `async/docker-compose.yml` (image figée, 2 CPU / 1 Go).

**Temps 2 — services**
4. Copie des cinq `domain.js` ; consommateurs de chaque service ; `POST /orders` en `202` et `GET /orders/:id`.
5. `async/docker-compose.yml` complet (projet `poc-async`), `Dockerfile`, tests unitaires.
6. `common/scripts/reset.js` : purge des files RabbitMQ quand `async/` tourne.
7. README, `CLAUDE.md` (état d'avancement), `docs/decisions-conception.md`.

## 6. Étapes de validation

Un seul projet actif à la fois : arrêter `sync/` avant de démarrer `async/` (mêmes ports).

```bash
docker compose -f sync/docker-compose.yml down
docker compose -f async/docker-compose.yml up -d --build --wait
(cd common && npm run reset)
```

### 6.1 Temps 1 (socle)

| # | Vérification | Résultat attendu |
|---|---|---|
| V1 | `(cd sync && npm test)` après D14 | Tous les tests passent |
| V2 | `sync/` : commande `SKU-LOW` × 51 | `REJECTED`, `INSUFFICIENT_STOCK`, paiement `VOIDED` (comportement inchangé) |
| V3 | RabbitMQ démarré | Conteneur `healthy` ; interface d'administration joignable ; échange `orders`, files et DLQ créées ; Prometheus voit `rabbitmq:15692` à `up = 1` |

### 6.2 Temps 2 (services)

| # | Vérification | Résultat attendu |
|---|---|---|
| V4 | Les 7 conteneurs (`postgres`, `rabbitmq`, 5 services) | `healthy` ; `up = 1` pour les 6 cibles Prometheus |
| V5 | Commande nominale | `202` immédiat avec `orderId` ; puis `GET /orders/:id` → `CONFIRMED`, `completedAt` renseigné |
| V6 | Paiement refusé (`tok_declined`) | `REJECTED`, `PAYMENT_DECLINED` ; notification `ORDER_REJECTED` ; ni réservation ni expédition |
| V7 | Stock insuffisant (`SKU-LOW` × 51) | `REJECTED`, `INSUFFICIENT_STOCK` ; paiement `VOIDED` ; notification `ORDER_REJECTED` |
| V8 | Requête invalide, SKU inconnu | `400` (`INVALID_REQUEST`, `UNKNOWN_SKU`), aucune commande créée |
| V9 | Panne de Payment : `stop payment`, 3 commandes, `start payment` | Pendant la panne : `202`, commandes `RECEIVED`, messages en attente dans la file `payment` ; au redémarrage : les 3 commandes se terminent sans intervention (contraste avec `sync/` : `502` et commande bloquée) |
| V10 | Idempotence : republier à la main un `OrderCreated` déjà traité | Aucun second paiement (I7 OK) ; une ligne de plus ignorée dans les logs |
| V11 | Outbox | Après drainage : aucune ligne d'`outbox` sans `published_at` |
| V12 | DLQ | Toutes les files `*.dlq` vides |
| V13 | Trace | Jaeger : une seule trace par commande, Order → Payment → Inventory → Order → Shipping → Notification → Order, temps en file visible |
| V14 | Invariants | `(cd common && npm run verify)` → OK sur I1 à I11 |
| V15 | Essai k6 court (essai à blanc, non cité) | 100 cmd/s pendant 1 min : `dropped_iterations` absent, 100 % de `202`, `verify` OK, `latency.js` donne les trois latences |
| V16 | `reset` | Vide la base **et** purge les files RabbitMQ |

Chaque vérification surprenante devient un cas de compréhension (`docs/cas-de-comprehension.md`).

## 7. Constats de mise en œuvre (2026-11-07)

Toutes les vérifications V1 à V16 sont passées. Écarts et corrections apportés en route :

| # | Constat | Correction | Source |
|---|---|---|---|
| M1 | Shipping a besoin de l'adresse de livraison, qui appartient à Order. | `getShippingAddress` ajoutée au `domain.js` d'Order, **dans les deux copies** (parité ; inutilisée par `sync/`). Order la transmet dans `OrderConfirmed`. Les articles voyagent de `OrderCreated` à `PaymentAuthorized` (Payment les retransmet à Inventory). | Proposition |
| M2 | Chaque publication prenait environ 40 ms chez Inventory, Shipping et Notification (vu dans Jaeger) : algorithme de Nagle combiné à l'ACK retardé de TCP. Une commande mettait 240 ms à se terminer au lieu d'environ 110 ms. | Connexion AMQP en `noDelay` (`async/lib/broker.js`). Cas de compréhension C6. | Proposition |
| M3 | Le balayage de secours de l'outbox créait une trace racine par seconde et par service, qui noyait les traces des commandes. | Balayage exécuté hors trace (`suppressTracing`, dépendance `@opentelemetry/core` ajoutée) ; une ligne publiée par le balayage garde sa trace (contexte restauré depuis `outbox.headers`). | Proposition |
| M4 | Jaeger (stockage en mémoire sans limite) a été tué faute de mémoire à 18 h 53, avant `dry-sync-02` ; le Collector, ne pouvant plus exporter, avait sa file pleine. | Jaeger plafonné (`MEMORY_MAX_TRACES=20000`, 1 Go) ; Collector redémarré. Les traces de `dry-sync-02` sont perdues ; ses mesures (base, k6) restent valables. | Proposition |
| M5 | Le contrôle k6 attendait `201` ; `async/` répond `202` (D4). | Le contrôle accepte `201` ou `202`. | Proposition |
| M6 | `POST /orders` répond avant la publication de `OrderCreated` (la commande et l'événement sont déjà durables dans l'outbox). | Choix assumé : la latence de réponse HTTP (H3c) ne contient pas l'attente de la confirmation du broker. Un échec de publication est rattrapé par le balayage. | Proposition |
| M7 | `reset` doit vider les files avant la base : un message restant recréerait des lignes après le vidage. | `reset.js` purge les files RabbitMQ (API d'administration) puis vide la base ; si RabbitMQ ne répond pas (projet `sync/`), la purge est sautée. | Proposition |
| M8 | Les compteurs de l'interface RabbitMQ (et de son API) se rafraîchissent toutes les 5 s environ. | Rien à corriger : lire l'état réel en base ou attendre le rafraîchissement. | Constat |
| M9 | Jaeger a de nouveau été tué faute de mémoire (20 h 41) malgré le plafond de M4 ; Grafana n'affichait plus aucun service (`no such host jaeger`). Causes : une commande `async/` produit environ 100 spans (surtout des requêtes SQL), donc 20 000 traces dépassent 1 Go ; et chaque appel à `/health` (toutes les 2 s) et à `/metrics` (toutes les 5 s) crée une trace, soit environ 3,5 traces/s de bruit pour 5 services, même sans commande. | **Proposées, non appliquées** (§8). Jaeger redémarré à la main. | Constat |

## 8. Corrections proposées pour un bon fonctionnement du banc d'essai (à appliquer)

Notées le 2026-11-07, à la suite de M9. À appliquer avant les mesures, identiquement pour `sync/` et `async/`.

| # | Correction | Fichiers | Effet attendu | État |
|---|---|---|---|---|
| C-1 | Ne plus tracer `/health` et `/metrics` (option `ignoreIncomingRequestHook` de l'instrumentation HTTP). | `sync/lib/telemetry.js`, `async/lib/telemetry.js` (même changement) | Supprime le bruit permanent ; Jaeger ne contient que des commandes | À faire |
| C-2 | Jaeger : `MEMORY_MAX_TRACES=5000`, `mem_limit` 1,5 Go. | `common/infra/docker-compose.yml` | Assez de traces pour inspecter un essai ; Jaeger ne tombe plus | **Appliquée le 2026-11-07** |
| C-3 | Échantillonner les traces pendant les runs de charge (par exemple 10 %, `OTEL_TRACES_SAMPLER=parentbased_traceidratio`), même taux pour les deux variantes. | `docker-compose.yml` des deux projets | Tracer 100 % des commandes coûte du CPU aux services (C5) et pèse sur les mesures ; le taux de traces complètes de H5 se mesurerait alors sur l'échantillon | À décider (D15) |
| C-4 | Vérifier que la pile d'observabilité tourne avant chaque run (Jaeger, Collector, Prometheus) et relancer le Collector si Jaeger a été recréé (sa file d'export peut rester pleine, M4). | protocole de run (`run-scenario.js`, étape 7) | Un run n'est pas mené avec une observabilité morte sans qu'on le sache | À faire à l'étape 7 |

Premier repère (essai à blanc `dry-async-01`, 100 cmd/s pendant 1 min, **jamais cité dans l'ADR**) : 6 001 commandes, drainage en moins de 1 s, `verify` OK, p95 d'acceptation 125 ms (contre 72 ms pour `dry-sync-01`), avec des pics ponctuels de p95 vers 20 s et 50 s, encore inexpliqués.

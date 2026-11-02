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

**Annoncé (par Régis)** : étapes 1 à 6 (socle, `sync/`, vérification d'invariant, `async/`, parité, traces) terminées ; étape en cours : **étape 7**, scénarios S1 à S5 (procédure : `poc-communication-etape7.md`).

**Constaté dans le dépôt au 2026-11-02** (le code fait foi) : seul le socle existe. Ne présume pas que le reste est fait ; revérifie avant chaque étape et mets cette liste à jour.

Présent :
- `package.json` + lockfile dans `sync/`, `async/`, `common/` (ESM, Node >= 22, `.nvmrc` = 22), dépendances installées.
- `common/infra/` : `docker-compose.yml` (projet `poc-obs` : Jaeger, OTel Collector, Prometheus, Grafana sur le réseau externe `poc-net`), `otel-collector.yml` (traces seulement → Jaeger), `prometheus.yml` (cibles `order:3000` … `notification:3004`, `rabbitmq:15692`).

Absent (dossiers vides ou fichiers manquants) :
- tout le code des services (`sync/services/*`, `async/services/*`, donc aucun `domain.js`), `lib/`, CLI `poc` ;
- `docker-compose.yml` de `sync/` et `async/` (PostgreSQL 17, RabbitMQ et les services n'apparaissent nulle part) ;
- `common/db/` (schéma, `seed.sql`), `common/benchmarks/` (k6), `common/scripts/` (`reset.js`, `verify-invariants.js`, `run-scenario.js`, `check-parity.js`) ;
- `docs/ADR-001.md` et le reste de `docs/` ;
- `poc-communication-etape7.md` ;
- aucun script npm (`npm test` est le stub par défaut), aucun test `node:test`.

Les crochets de l'étape 7 (section 8) n'existent donc pas encore. Les commandes de la section 9, hormis les deux premières, ne fonctionnent pas encore.

Autres écarts :
- Le dépôt s'appelle `poc-projet-01`, pas `poc-communication`.
- Les images de `common/infra/docker-compose.yml` sont en `:latest` : à figer avant les runs mesurés pour que les répétitions restent comparables.

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

- **Acceptée** = paiement passé (précision de Régis). **Confirmée** = transaction sur Order.
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
- Les latences se calculent **depuis la base**, avec les mêmes requêtes pour A et B. Latence d'acceptation = `accepted_at − received_at` (critère p95 < 1 s, précision de Régis du 2026-10-27) ; confirmation ; complétion. Ne compare jamais le p95 d'acceptation d'une variante au p95 de complétion de l'autre.
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

k6 n'est pas installé sur la machine de Régis : l'exécuter via Docker sur `poc-net` (`grafana/k6`, cible `http://order:3000` passée par `-e TARGET`).

## 10. Conventions de travail

- Réponds en **français** ; le code, les identifiants et les noms de métriques restent en anglais.
- Documente la compréhension : quand tu prends une décision de conception, note-la dans `docs/` (ADR ou fichier dédié) en distinguant **ce qui vient de l'énoncé**, **ce que Régis a décidé**, et **ce que tu proposes**.
- Ne présente jamais un résultat comme mesuré s'il ne l'a pas été. Cite le fichier de `results/` qui le prouve.
- Ne remplis pas la matrice de décision par des opinions : chaque cellule cite un résultat.
- Les scripts doivent être idempotents quand c'est possible (reset, seed) et ne jamais supprimer `results/` sans demande.
- Ne modifie pas `docs/ADR-001.md` « Candidate decision » après coup : c'est l'intuition de départ, volontairement figée avant les preuves.
- Avant tout changement dans un `domain.js`, applique la règle de parité (section 3).

## 11. Décisions encore ouvertes

| # | Question | Valeur par défaut |
|---|---|---|
| D4 | Réponse initiale en B | `202` sur « reçue », « acceptée » mesurée par horodatage |
| D5 | Où se place la confirmation | Dès `InventoryReserved` |
| D8 | Durée de S1, forme du pic de S2 | S1 : 3 min ; S2 : montée 2 min puis palier 5 min |
| D12 | Mélange de charge | 3 % de paiements refusés, 2 % sur `SKU-LOW` |

Si une de ces décisions a été tranchée depuis, mets ce tableau à jour plutôt que de t'y fier.

## 12. Hypothèses suivies

- **H1 — Scalabilité** : sous forte charge, l'événementiel maintient un débit supérieur (S2).
- **H2 — Latence** : le synchrone offre une latence plus faible en charge normale (S1).
- **H3 — Résilience** : en cas de dépendance indisponible, l'événementiel accepte des commandes dans davantage de situations (S3, S4). Attention : S3/S4 ciblent Payment, qui est dans le chemin de l'invariant ; accepter sans paiement autorisé ne peut être qu'une acceptation « en attente », jamais une confirmation.
- Hypothèses additionnelles proposées : l'événementiel exige une idempotence explicite pour tenir l'invariant (S5) ; la reconstruction d'une commande est plus coûteuse en événementiel.

Chaque métrique doit répondre à : **quelle hypothèse permet-elle d'évaluer ?**

## 13. Limites à garder à l'esprit

Services simulés (latences et pannes injectées) ; un seul hôte (k6, base, broker, services, monitoring se partagent les ressources) ; PostgreSQL commun pouvant masquer l'effet du style ; résultats dépendants de la configuration RabbitMQ (conclure sur le style, pas sur le broker) ; Node mono-processus par service ; chorégraphie plutôt qu'orchestration en B. Conclure sur **ce rig**, pas sur « le synchrone » ou « l'événementiel » en général.
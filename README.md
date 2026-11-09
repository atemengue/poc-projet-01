# POC : communication synchrone vs asynchrone

Preuve de concept qui compare deux façons de faire communiquer les mêmes 5 microservices d'un flux e-commerce (`order`, `payment`, `inventory`, `shipping`, `notification`) :

- **`sync/`** : appels HTTP directs entre services (Fastify + undici) ;
- **`async/`** : échanges par messages via RabbitMQ (amqplib).

Les deux variantes partagent la même pile d'observabilité (traces, métriques) pour pouvoir être mesurées et comparées.

> **État actuel :** les deux variantes, l'observabilité, la vérification des invariants et le banc d'essai (scénarios S1 à S5) sont en place, pilotés par la CLI `./poc`. Résultats : `docs/resultats.md` ; présentation : `docs/presentation-poc.md`.

## Démarrage rapide (CLI `./poc`)

Toutes les opérations passent par `./poc`, à la racine (Node 22, sans dépendance ajoutée ; code dans `common/cli/`). Les étapes détaillées et les commandes Docker équivalentes sont dans les sections suivantes.

```bash
docker network create poc-net        # une seule fois (ignorer « already exists »)
(cd sync && npm install) ; (cd async && npm install) ; (cd common && npm install)

./poc up sync                        # démarre sync (arrête async, démarre l'observabilité si besoin)
./poc check                          # santé, infrastructure, parité, trois commandes témoins
./poc status                         # conteneurs, cibles Prometheus, réglages du run
./poc order --sku SKU-001 --qty 2    # passer une commande à la main
./poc reset                          # effacer les commandes (et purger RabbitMQ en async)

./poc scenario s1 --project sync --rep 1     # un run complet selon le protocole
./poc up async
./poc scenario s1 --project async --rep 1

./poc down                           # arrêter les variantes (bases conservées)
```

### Référence des commandes

| Commande | Rôle |
|---|---|
| `./poc help` | Liste des commandes |
| `./poc build [sync\|async]` | Construire l'image des services |
| `./poc up sync\|async [--build]` | Démarrer une variante ; arrête l'autre (mêmes ports), démarre l'observabilité si elle est arrêtée, attend que tout soit prêt |
| `./poc down [--obs] [--volumes [--yes]]` | Arrêter les variantes ; `--obs` arrête aussi l'observabilité ; **`--volumes` efface les bases** (confirmation demandée) |
| `./poc status` | Variante active, conteneurs, cibles Prometheus, réglages du run (traces, idempotence, doublons, latence de Payment) |
| `./poc check` | Santé des services, Prometheus, Jaeger, RabbitMQ (DLQ), parité, et trois commandes témoins : paiement autorisé, refusé, stock insuffisant avec annulation du paiement. Code 0 si tout est en ordre |
| `./poc logs <service> [--follow] [--tail N]` | Logs d'un service (`order` … `notification`, `postgres`, `rabbitmq`) |
| `./poc config [--traces 0.1] [--idempotency on\|off] [--duplicates 2]` | Changer les réglages du run (recrée les services) ; les options absentes reviennent à leur valeur par défaut ; `./poc up` remet tout par défaut |
| `./poc chaos <service> --latency <ms>` / `--off` | Ralentir un service (S3), puis le rétablir |
| `./poc fault stop\|start <service>` | Arrêter ou redémarrer un service (S4, S4b) |
| `./poc reset` | Remettre la base à zéro et purger les files RabbitMQ |
| `./poc order [--sku SKU-001,SKU-003] [--qty 2] [--card tok_ok\|tok_declined] [--no-wait]` | Passer une commande ; en async, attend son état final (compensation comprise) |
| `./poc order get <orderId>` | Relire une commande |
| `./poc test` | Tests de `sync/`, `async/` et `common/` (ceux de `common/` exigent une variante démarrée) |
| `./poc verify [--out <fichier>]` | Vérifier les invariants I1 à I11 |
| `./poc latency --run <RUN_ID> [--phase measure] [--slice 10]` | Latences et débit d'un run, depuis la base |
| `./poc traces --project sync\|async --run <RUN_ID> [--phase measure]` | Part de traces complètes (H5) |
| `./poc parity` | Parité sync / async (`domain.js` et configuration) |
| `./poc scenario <s1\|s2\|s3\|s4\|s4b\|s5> --project sync\|async --rep <n> [--witness\|--no-duplicates] [--tag <txt>]` | Un run complet selon le protocole (`common/scripts/run-scenario.js`) ; résultats dans `results/<projet>/<scénario>/rep-<n>/` |
| `./poc load [--rate 100] [--duration 1m] [--profile constant\|steps]` | Charge k6 libre, rangée en essai à blanc (`results/dry-run/`, jamais citée) |

### Lancer les scénarios

Un scénario se lance en deux temps : démarrer la variante, puis lancer le scénario sur cette variante. Au lancement, le script rappelle le scénario et les hypothèses qu'il évalue ; à la fin, il affiche **VALIDE**, **VALIDE SOUS SATURATION** (ne peut servir qu'à rejeter une hypothèse) ou **INVALIDE**, avec la raison. Les résultats vont dans `results/<projet>/<scénario>/rep-<n>/`.

```bash
./poc up sync                                   # démarre sync (et arrête async)
./poc check                                     # facultatif : tout est en ordre ?
./poc scenario s1 --project sync --rep 1        # lance S1 sur sync

./poc up async                                  # bascule sur async
./poc scenario s1 --project async --rep 1       # même scénario sur async
```

| Commande | Scénario | Durée de la charge |
|---|---|---|
| `./poc scenario s1 --project … --rep N` | S1 : charge normale, 100 cmd/s (exigence S1, H2, H5) | 4 min |
| `./poc scenario s2 --project … --rep N` | S2 : pic, paliers jusqu'à 500 cmd/s (H1) | 10 min, plus le drainage |
| `./poc scenario s3 --project … --rep N` | S3 : Payment lent, 2 s pendant 60 s (H3c) | 4 min |
| `./poc scenario s4 --project … --rep N` | S4 : Payment arrêté 30 s (H3b) | 4 min |
| `./poc scenario s4b --project … --rep N` | S4b : Shipping arrêté 30 s (H3a) | 4 min |
| `./poc scenario s5 --project … --rep N` | S5 : doublons, avec protection (H4) | 2 min |
| `./poc scenario s5 --project … --rep N --no-duplicates` | S5 : référence sans doublons (surcoût de H4) | 2 min |
| `./poc scenario s5 --project … --rep N --witness` | S5 : témoin, doublons sans protection | 2 min |

À savoir :
- `--project` doit être la variante démarrée ; sinon le run est refusé, avec la commande à lancer.
- `--rep` est le numéro de répétition ; un résultat existant n'est jamais remplacé (choisir une autre répétition ou `--tag <txt>`).
- Deux répétitions par scénario et par variante sont nécessaires pour un verdict définitif ; alterner l'ordre d'une répétition à l'autre (répétition 1 : sync puis async ; répétition 2 : async puis sync).
- Le nom d'un run est `<projet>-<scénario>-r<n>` (ex. `sync-s1-r2`) : `./poc latency --run sync-s1-r2 --phase measure` relit ses latences.

Exemple : répétition 2 de S1, S3, S4 et S4b dans les deux variantes (environ 25 min par variante) :

```bash
./poc up sync
for s in s1 s3 s4 s4b; do ./poc scenario $s --project sync --rep 2; done

./poc up async
for s in s1 s3 s4 s4b; do ./poc scenario $s --project async --rep 2; done
```

Exemple : S5 complet sur une variante (protection, référence, témoin) :

```bash
./poc up async
./poc scenario s5 --project async --rep 3 --no-duplicates
./poc scenario s5 --project async --rep 3
./poc scenario s5 --project async --rep 3 --witness
```

À venir : `./poc campaign` (série de runs, alternance de l'ordre sync / async à chaque répétition) et `./poc report` (verdicts H1 à H5 calculés depuis les résultats, `results/REPORT.md`).

## Prérequis

- [Node.js](https://nodejs.org/) 22 ou plus (la version est fixée dans `.nvmrc`)
- [Docker](https://docs.docker.com/get-docker/) avec Docker Compose

## Démarrage

Toutes les commandes se lancent depuis la racine du dépôt.

### 1. Sélectionner la version de Node

```bash
nvm use        # lit .nvmrc (Node 22)
```

### 2. Installer les dépendances

`sync/`, `async/` et `common/` sont trois paquets npm indépendants : il faut lancer l'installation dans chacun.

```bash
(cd common && npm install)
(cd sync && npm install)
(cd async && npm install)
```

### 3. Créer le réseau Docker

Les fichiers Compose utilisent un réseau externe `poc-net`, qu'il faut créer une seule fois :

```bash
docker network create poc-net
```

Si le réseau existe déjà, la commande renvoie `network with name poc-net already exists` : c'est sans conséquence.

### 4. Démarrer la pile d'observabilité

```bash
docker compose -f common/infra/docker-compose.yml up -d
```

| Outil | Adresse |
|---|---|
| Jaeger (traces) | http://localhost:16686 |
| Prometheus (métriques) | http://localhost:9090 |
| Grafana (tableaux de bord) | http://localhost:3100 (`admin` / `admin`) |
| OTel Collector (réception OTLP/HTTP) | `localhost:4318` |

Grafana est configuré par fichiers (`common/infra/grafana/`) : les sources de données Prometheus et Jaeger sont déjà déclarées, et tout tableau de bord JSON placé dans `common/infra/grafana/dashboards/` est chargé dans le dossier « POC ». Ce qui est créé dans l'interface est perdu quand le conteneur est recréé : exporter en JSON pour le garder.

Pour arrêter la pile :

```bash
docker compose -f common/infra/docker-compose.yml down
```

### 5. Démarrer la variante synchrone

Un seul projet (`sync/` ou `async/`) doit tourner à la fois.

```bash
docker compose -f sync/docker-compose.yml up -d --build --wait
```

La commande construit l'image des services, puis démarre PostgreSQL et les 5 services ; elle rend la main quand tous sont prêts (`healthy`). `--build` n'est nécessaire qu'après une modification du code.

PostgreSQL 17 démarre avec le schéma (`common/db/schema.sql`) et les données de départ (`common/db/seed.sql`), chargés automatiquement au premier démarrage.

- Depuis la machine : `postgres://poc:poc@localhost:55432/poc` (port 55432 pour ne pas entrer en conflit avec un PostgreSQL local)
- Depuis les conteneurs de `poc-net` : `postgres://poc:poc@postgres:5432/poc`

Pour tout arrêter (les données sont conservées) :

```bash
docker compose -f sync/docker-compose.yml down
```

Pour repartir d'une base vide (`-v` supprime le volume ; schéma et données de départ sont rechargés au redémarrage) :

```bash
docker compose -f sync/docker-compose.yml down -v
docker compose -f sync/docker-compose.yml up -d --wait
```

### 6. Démarrer la variante asynchrone (à la place de la synchrone)

Arrêter d'abord `sync/` (mêmes ports), puis démarrer `async/` :

```bash
docker compose -f sync/docker-compose.yml down
docker compose -f async/docker-compose.yml up -d --build --wait
```

Démarre PostgreSQL, RabbitMQ et les 5 services. `async/` a **sa propre base** (volume distinct de celui de `sync/`), au même port 55432 : `reset`, `verify` et `latency.js` s'appliquent au projet qui tourne.

RabbitMQ :
- interface d'administration : http://localhost:15672 (`poc` / `poc`) ; les compteurs des files se rafraîchissent toutes les 5 s environ ;
- topologie déclarée au démarrage par `async/rabbitmq/definitions.json` : échange `orders` (topic), une file par service, une file `<service>.dlq` par service pour les messages en échec.

Conception et étapes de validation : `docs/async-mise-en-place.md`.

## Passer une commande

```bash
curl -X POST localhost:3000/orders -H 'content-type: application/json' -d '{
  "customerId": "c1",
  "items": ["SKU-001", "SKU-003"],
  "quantity": 2,
  "paymentInformation": { "cardToken": "tok_ok" },
  "shippingAddress": { "line1": "1 rue X", "city": "Montréal" }
}'
```

Forme de l'énoncé : `items` est une liste de SKU et `quantity` s'applique à chaque article (ici 2 × SKU-001 et 2 × SKU-003).

Réponse attendue :
- **sync** : `201` avec `"status":"CONFIRMED","completed":true` (la réponse arrive après tout le workflow) ;
- **async** : `202` avec `"status":"RECEIVED"` (la commande est enregistrée ; la suite se fait par événements).

Suivre la commande : `curl localhost:3000/orders/<orderId>` (en async, `CONFIRMED` et `completedAt` apparaissent environ 100 à 300 ms plus tard).

| Pour obtenir | Modifier la requête |
|---|---|
| un paiement refusé (`REJECTED`, `PAYMENT_DECLINED`) | `"cardToken": "tok_declined"` |
| un stock insuffisant (`REJECTED`, `INSUFFICIENT_STOCK`, paiement annulé) | `"items": ["SKU-LOW"], "quantity": 51` |
| une panne de dépendance | arrêter un service avant : `docker compose -f <projet>/docker-compose.yml stop payment` (puis `start payment`). En sync : `502`, commande bloquée. En async : `202`, commande `RECEIVED` tant que Payment est arrêté, puis terminée toute seule à son redémarrage. |

Tests unitaires : `(cd sync && npm test)` et `(cd async && npm test)`.

## Vérifier les invariants et remettre à zéro

Les invariants (I1 à I11, `docs/invariants.md`) se vérifient en une commande, une fois toutes les commandes en cours terminées :

```bash
(cd common && npm run verify)
```

Le rapport sépare **sûreté** (I1–I9, ne doit jamais arriver) et **vivacité** (I10–I11, doit finir par arriver), avec les commandes en infraction. Code de sortie : `0` tout est respecté, `1` au moins une violation (un résultat à documenter, pas une erreur), `2` vérification impossible ou base vide. Pour garder une trace : `(cd common && npm run verify -- --out ../results/essai/invariants.json)`.

Remettre le POC dans son état de départ (vide les commandes, remet le stock et, si `async/` tourne, purge toutes les files RabbitMQ), sans redémarrer les conteneurs :

```bash
(cd common && npm run reset)
```

Tests du vérificateur (une violation injectée par règle, sans modifier la base) : `(cd common && npm test)`.

## Vérifier la parité entre sync et async

La comparaison n'est valable que si seul le style de communication diffère. Un contrôle le vérifie :

```bash
(cd common && npm run parity)
```

Il compare les cinq `services/<nom>/domain.js` des deux projets (empreinte SHA-256, première ligne qui diffère) et leur configuration Compose (ressources, pool, latence simulée, `PREFETCH` = `OUTBOUND_CONNECTIONS`). Code de sortie : `0` parité respectée, `1` divergence (à corriger, ou à documenter dans l'ADR si elle est voulue), `2` contrôle impossible. Pas besoin que les piles tournent ; Docker doit être disponible.

## Retrouver la trace d'une commande

Chaque commande produit une trace qui traverse les services (requêtes SQL comprises). Pour la retrouver à partir de son `orderId` :

- **Jaeger** (http://localhost:16686) : *Service* `order`, *Tags* `order.id=<orderId>`, **Find Traces** ;
- **Grafana** → **Explore** → source **Jaeger** → *Search* : *Service* `order`, *Tags* `order.id=<orderId>` ;
- ou par le `traceId` donné dans les logs d'Order (`order processed` en sync, `order received` en async) :
  `docker compose -f <projet>/docker-compose.yml logs order | grep <orderId>`.

Les opérations portent le nom de la route (`POST /orders`, `POST /payments`…) ; en async, chaque traitement d'événement apparaît comme `<service> process` avec l'attribut `event.type`. Jaeger garde les 5 000 dernières traces.

## Lancer une charge (k6) et mesurer les latences

k6 tourne dans Docker sur `poc-net` (image figée). Chaque run a un identifiant (`RUN`) : il préfixe les `customerId` (pour retrouver les commandes en base) et étiquette les métriques k6 dans Prometheus (`testid`).

```bash
K6=grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8
RUN=dry-sync-01
OUT=results/dry-run/sync/$RUN && mkdir -p $OUT

(cd common && npm run reset)

docker run --rm --network poc-net \
  -v "$PWD/common/benchmarks:/scripts:ro" -v "$PWD/results:/results" \
  -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
  -e K6_PROMETHEUS_RW_TREND_STATS='p(50),p(95),p(99),avg,max' \
  $K6 run -o experimental-prometheus-rw --tag testid=$RUN \
  -e RUN_ID=$RUN -e RATE=100 -e DURATION=1m \
  --summary-export=/results/dry-run/sync/$RUN/k6-summary.json /scripts/place-order.js

(cd common && npm run verify -- --out ../$OUT/invariants.json)
node common/scripts/latency.js --run $RUN --out $OUT/latency.json
```

- Pendant le run : Grafana → dossier **POC** → tableau **POC — Run k6 et services** (choisir le run dans la liste `Run`). Il montre la charge vue par k6 (débit, itérations perdues, statuts HTTP, latence de réponse, VUs) et ce qu'encaissent les services (CPU, boucle d'événements, mémoire).
- `latency.js` donne les statuts, le débit et les latences d'acceptation, de confirmation et de complétion (p50/p95/p99), calculés depuis la base. Ce sont elles qui comptent pour les verdicts ; la latence HTTP de k6 sert de contrôle.
- Un essai à blanc (`results/dry-run/`) sert à calibrer le banc d'essai ; il n'est jamais cité comme résultat.

## Vérifier que tout fonctionne

**Grafana** : dans *Connections → Data sources*, ouvrir `Prometheus` puis `Jaeger` et cliquer sur **Test** : un message vert doit apparaître.

**Prometheus** : dans Grafana, *Explore* → source `Prometheus` → requête `up`. Avec la variante synchrone démarrée, les 5 services valent 1 et `rabbitmq` vaut 0 (il n'existe que dans la variante asynchrone).

**Traces des services** : après une commande, chercher le service `order` dans Jaeger (http://localhost:16686) : la trace montre les appels vers les autres services et les requêtes SQL.

**Traces (test sans les services)** : envoyer une trace de test au collecteur, puis la chercher dans Jaeger (http://localhost:16686, service `test-grafana`) ou dans Grafana (*Explore* → `Jaeger` → *Search*) :

```bash
NOW=$(($(date +%s) * 1000000000))
curl -X POST localhost:4318/v1/traces -H 'Content-Type: application/json' -d "{
  \"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"test-grafana\"}}]},
  \"scopeSpans\":[{\"spans\":[{\"traceId\":\"0af7651916cd43dd8448eb211c80319c\",\"spanId\":\"b7ad6b7169203331\",
  \"name\":\"test-span\",\"kind\":1,\"startTimeUnixNano\":\"$NOW\",\"endTimeUnixNano\":\"$((NOW+50000000))\"}]}]}]}"
```

**PostgreSQL** :

```bash
docker compose -f sync/docker-compose.yml exec postgres psql -U poc -d poc -c '\dt' -c 'SELECT sku, stock FROM products ORDER BY sku'
```

10 tables attendues, puis 5 SKU à 1 000 000 et `SKU-LOW` à 50.

## Ports des services

Prometheus est déjà configuré pour collecter les métriques des services sur le réseau `poc-net`, avec ces noms d'hôte et ports :

| Service | Port |
|---|---|
| order | 3000 |
| payment | 3001 |
| inventory | 3002 |
| shipping | 3003 |
| notification | 3004 |
| rabbitmq (variante async seulement) | 15692 |

## Structure

```
sync/      variante synchrone : services/<nom>/{domain,server}.js, lib/, test/, Dockerfile, docker-compose.yml
async/     variante asynchrone : services/<nom>/{domain,server}.js, lib/ (broker, outbox, consommateur), rabbitmq/, test/
common/    éléments partagés, hors comparaison
  infra/     monitoring : Jaeger, OTel Collector, Prometheus, Grafana
  db/        schéma, données de départ, conteneur PostgreSQL commun
  benchmarks/  charge k6 (place-order.js)
  scripts/     reset, verify-invariants, latency, check-parity
docs/      ADR-001, hypothèses, décisions de conception, invariants, mise en place async, cas de compréhension
CLAUDE.md  règles du POC, état d'avancement réel
```

Les résultats des benchmarks vont dans `results/` (ignoré par git).

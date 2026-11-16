# POC : communication synchrone vs asynchrone


## Équipe

- Regis Atemengue
- Louis Félix St-Amour


Preuve de concept qui compare deux façons de faire communiquer les mêmes 5 microservices d'un flux e-commerce (`order`, `payment`, `inventory`, `shipping`, `notification`) :

- **`sync/`** : appels HTTP directs entre services (Fastify + undici) ;
- **`async/`** : échanges par messages via RabbitMQ (amqplib).

Les deux variantes partagent la même pile d'observabilité (traces, métriques) pour pouvoir être mesurées et comparées.

> **État actuel :** les deux variantes, l'observabilité, la vérification des invariants et le banc d'essai (scénarios S1 à S5) sont en place, pilotés par la CLI `./poc`. Résultats : `docs/resultats.md` ; présentation : `docs/presentation-poc.md`.

Livrables : `docs/POC-plan.md` (PoC Plan), `docs/resultats.md` (résultats des scénarios), `docs/architecture-analysis.md` (Architecture Analysis), `docs/ADR-001.md` (ADR final ; version initiale : `docs/ADR-001-initial.md`), exports PDF dans `reports/`.

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

## Observer un run : lire les graphiques et les outils d'observabilité

Les outils d'observabilité servent à **comprendre** un run pendant qu'il tourne ou juste après : où le système attend, ce qui sature, ce qu'est devenue une commande. **Ils ne donnent pas les verdicts** : les latences et débits qui comptent sont calculés en base et écrits dans `results/<projet>/<scénario>/rep-<n>/` (`latency.json`, `run.json`, `invariants.json`).

| Outil | Adresse | Sert à voir |
|---|---|---|
| Grafana | http://localhost:3100 (`admin` / `admin`) | La charge envoyée par k6 et ce qu'encaissent les services, en courbes |
| Prometheus | http://localhost:9090 | Les mêmes métriques, par requête PromQL (ou via Grafana → *Explore*) |
| Jaeger | http://localhost:16686 | Le parcours d'une commande à travers les services (traces) |
| RabbitMQ | http://localhost:15672 (`poc` / `poc`), async seulement | Les files : messages en attente, en cours, en échec |
| `docker stats` | terminal | CPU et mémoire de chaque conteneur, y compris k6 |

### Grafana : le tableau « POC — Run k6 et services »

**Ouvrir** : Grafana → *Dashboards* → dossier **POC** → **POC — Run k6 et services**. Le tableau se rafraîchit toutes les 5 s et montre les 15 dernières minutes.

**Choisir le run** : liste **Run** en haut à gauche. Le nom est l'identifiant du run : `<projet>-<scénario>-r<n>` pour `./poc scenario` (par exemple `sync-s2-r3`, `async-s5-witness-r1`). Après un run, élargir la période (en haut à droite, par exemple *Last 1 hour*) pour le voir en entier.

**Ligne 1 — k6 : la charge vue par le client**

| Graphique | Ce qu'il montre | Normal | Signal d'alerte |
|---|---|---|---|
| **Débit : itérations lancées et requêtes HTTP** | Requêtes envoyées par seconde | Suit le profil : marches de 100, 200… en S2, palier plat en S1 | La courbe passe sous le débit prévu : k6 n'a plus de VU libre pour envoyer (voir le graphique suivant) |
| **Itérations perdues** | Requêtes que k6 n'a pas pu envoyer | Vide ou 0 | Des pics : au-delà de 1 % sur le run, le run est invalide ou « valide sous saturation » (voir `run.json` → `validity`) |
| **Statuts HTTP de POST /orders** | Réponses par code | `201` en sync, `202` en async | `502` : une dépendance a échoué (sync, S4) ; `0` : le client a abandonné au bout de 5 s |
| **Latence de réponse HTTP (vue client)** | p50, p95, p99 du temps de réponse vu par k6 | Quelques ms en async, environ 100 ms en sync à 100 cmd/s | Plateau à 5 s : les requêtes atteignent le délai client et sont abandonnées |
| **Échecs** | Part des requêtes sans la réponse attendue | 0 | Tout ce qui monte ; à croiser avec les statuts |
| **VUs actifs** | Requêtes en vol côté k6 | Quelques dizaines | Monte vers 3 000 : le système ralentit (requêtes en vol = débit × temps de réponse) |

Rappel : en async, la réponse HTTP (`202`) arrive **avant** le traitement. Une latence HTTP basse ne veut pas dire que les commandes sont traitées vite : regarder les files (RabbitMQ) et, après le run, `latency.json`.

**Ligne 2 — Services : ce qu'ils encaissent**

| Graphique | Ce qu'il montre | Normal | Signal d'alerte |
|---|---|---|---|
| **CPU par service** | CPU consommé, 1 = un cœur (la limite de chaque service) | Bien sous 1 | Une courbe collée à 1 : ce service est le goulot (Order en sync dès 300 cmd/s) |
| **Retard de la boucle d'événements p99** | Temps d'attente avant que Node traite une tâche | Quelques ms | Des centaines de ms : le service ne suit plus, les requêtes attendent leur tour |
| **Ressources ouvertes** | Sockets et minuteurs ouverts par service | Stable | Monte sans redescendre : connexions accumulées (appels en attente) |
| **Mémoire résidente** | Mémoire de chaque service | Stable, loin de 512 Mo | Approche 512 Mo : risque d'arrêt du conteneur |

**Ce que montrent les graphiques selon le scénario**

| Scénario | Synchrone | Asynchrone |
|---|---|---|
| S1 (100 cmd/s) | Tout est plat et bas | Tout est plat et bas |
| S2 (pic) | Order monte à 1 CPU, la boucle d'événements d'Order s'allonge, latence HTTP à 5 s, statuts `0` (abandons), VUs vers 3 000 | Latence HTTP basse longtemps, mais les files grossissent dans RabbitMQ ; la base et Order saturent ; les traitements continuent plusieurs minutes après la fin de la charge |
| S3 (Payment lent) | Latence HTTP à 5 s, statuts `0` pendant la fenêtre de 60 s | Latence HTTP inchangée ; la file de Payment se remplit puis se vide |
| S4 (Payment arrêté) | Statuts `502` pendant 30 s, la courbe CPU de Payment disparaît | `202` inchangés ; la file de Payment se remplit pendant 30 s puis se vide au redémarrage |
| S4b (Shipping arrêté) | Statuts `502` pendant 30 s | `202` inchangés ; la file de Shipping se remplit puis se vide |

**Piège** : après la fin d'un run, les courbes k6 restent plates pendant environ 5 minutes à leur dernière valeur. Ce n'est pas une mesure : Prometheus renvoie la dernière valeur reçue tant que la série n'a pas expiré.

### Prometheus : requêtes utiles

Dans Grafana → *Explore* → source **Prometheus** (ou http://localhost:9090) :

| Requête | Ce qu'elle montre |
|---|---|
| `up` | Services collectés : 1 = joignable, 0 = arrêté (en sync, `rabbitmq` vaut 0, c'est normal) |
| `rate(process_cpu_seconds_total{job="services"}[30s])` | CPU par service (1 = la limite) |
| `inflight_requests` | Requêtes HTTP en cours de traitement, par service |
| `outbound_pool_pending` | Sync : appels sortants en attente d'une connexion libre, par service cible (l'équivalent d'une file d'attente) |
| `rabbitmq_queue_messages_ready` | Async : messages en attente dans les files (total) |
| `rabbitmq_queue_messages_unacked` | Async : messages en cours de traitement, pas encore acquittés |
| `duplicates_detected_total` | Doublons écartés par l'idempotence (S5) |
| `sum(rate(k6_http_reqs_total{testid="<run>"}[15s]))` | Débit envoyé par k6 pour un run donné |

`./poc scenario` enregistre ces séries pour la durée du run dans `prometheus.json` (non versionné).

### Jaeger : suivre une commande

1. Récupérer un identifiant de commande (`./poc order`, ou dans la base).
2. Jaeger → *Service* `order`, *Tags* `order.id=<orderId>`, **Find Traces** ; ou Grafana → *Explore* → source **Jaeger** → *Search*.
3. Ouvrir la trace : chaque barre est une opération, sa longueur est sa durée, son décalage est le moment où elle commence.

**Lire la trace**

- **Synchrone** : une seule requête `POST /orders` qui contient, l'un après l'autre, les appels à Payment, Inventory, Shipping et Notification, avec leurs requêtes SQL. La durée totale est le temps de réponse du client. Une barre anormalement longue désigne l'étape lente (en S3, l'appel à Payment dure 2 s).
- **Asynchrone** : `POST /orders` est courte (le client a sa réponse), puis une suite de traitements `<service> process`, chacun avec l'attribut `event.type` (`OrderCreated`, `PaymentAuthorized`…). Les **espaces vides** entre deux traitements sont le temps passé dans la file : c'est là que se voit l'attente au pic ou pendant une panne.
- Une trace complète passe par les cinq services. S'il en manque, la commande n'est pas allée au bout (refus de paiement, stock insuffisant) ou est restée bloquée.

**Attention** : pendant S1 à S4, seule une commande sur dix est tracée (échantillonnage de 10 %, identique dans les deux variantes) : une commande peut ne pas avoir de trace. Jaeger ne garde que les 5 000 dernières traces : chercher juste après le run. En S5 et hors scénario, toutes les commandes sont tracées.

### RabbitMQ (async) : les files

Interface http://localhost:15672 (`poc` / `poc`) → onglet **Queues and Streams**. Les compteurs se rafraîchissent toutes les 5 s environ.

| Colonne ou file | Sens | Normal | Signal d'alerte |
|---|---|---|---|
| **Ready** | Messages en attente d'être traités | Proche de 0 | Grossit : le service consommateur ne suit pas, ou il est arrêté (S4, S4b) |
| **Unacked** | Messages en cours de traitement | Au plus 64 par file (la concurrence fixée) | Bloqué à 64 longtemps : le consommateur est saturé |
| **Incoming / deliver** | Messages publiés et livrés par seconde | Égaux | Livré < publié : la file se remplit |
| Files `<service>.dlq` | Messages en échec, mis de côté | **Toujours vides** | Un message ici est une erreur de traitement à examiner (`./poc check` les signale) |

En cliquant sur une file, le graphique *Queued messages* montre comment elle s'est remplie puis vidée pendant le run.

### `docker stats` : CPU et mémoire des conteneurs

```bash
docker stats                              # tous les conteneurs, y compris k6 (poc-k6-<run>)
```

- **CPU %** : 100 % = un cœur. Limites : 100 % pour chaque service, 200 % pour PostgreSQL et RabbitMQ. Une valeur au-dessus de la limite est un artefact d'échantillonnage : le conteneur est à son plafond.
- **k6** : s'il dépasse environ 400 %, c'est lui qui charge la machine, et le run ne mesure plus seulement le système (règle de validité, `docs/decisions-conception.md`, PC7 et PC11).
- `./poc scenario` relève ces valeurs pendant le run (`resources.json`, non versionné) et reporte le maximum de k6 dans `run.json` → `k6.resources`.

### Après le run : les fichiers de résultats

| Fichier | Contenu | Clés utiles |
|---|---|---|
| `run.json` | Validité, phases, mesures k6, panne, doublons | `validity`, `invalidReasons`, `k6.droppedRatio`, `k6.phases`, `k6.resources`, `drain`, `lost`, `duplicates` |
| `latency.json` | Latences calculées en base, par phase | `measure.latency.acceptance.p95`, `byPhase.<phase>`, `slices10s` (évolution par tranches de 10 s) |
| `invariants.json` | Vérification de I1 à I11 | `verdict`, `results[].violations` |
| `traces.json` (S1) | Part de traces complètes | `completeRatio`, `tracedOrders` |

```bash
./poc latency --run <runId>               # latences par phase, depuis la base
./poc verify                              # invariants
```

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

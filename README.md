# POC : communication synchrone vs asynchrone

Preuve de concept qui compare deux façons de faire communiquer les mêmes 5 microservices d'un flux e-commerce (`order`, `payment`, `inventory`, `shipping`, `notification`) :

- **`sync/`** : appels HTTP directs entre services (Fastify + undici) ;
- **`async/`** : échanges par messages via RabbitMQ (amqplib).

Les deux variantes partagent la même pile d'observabilité (traces, métriques) pour pouvoir être mesurées et comparées.

> **État actuel :** la pile d'observabilité et la base PostgreSQL sont en place, mais le code des services n'est pas encore écrit. Le lancement des services sera ajouté ici au fur et à mesure.

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

### 5. Démarrer la base de la variante synchrone

Un seul projet (`sync/` ou `async/`) doit tourner à la fois.

```bash
docker compose -f sync/docker-compose.yml up -d --wait
```

PostgreSQL 17 démarre avec le schéma (`common/db/schema.sql`) et les données de départ (`common/db/seed.sql`), chargés automatiquement au premier démarrage.

- Depuis la machine : `postgres://poc:poc@localhost:55432/poc` (port 55432 pour ne pas entrer en conflit avec un PostgreSQL local)
- Depuis les conteneurs de `poc-net` : `postgres://poc:poc@postgres:5432/poc`

Pour arrêter la base (les données sont conservées) :

```bash
docker compose -f sync/docker-compose.yml down
```

Pour repartir d'une base vide (`-v` supprime le volume ; schéma et données de départ sont rechargés au redémarrage) :

```bash
docker compose -f sync/docker-compose.yml down -v
docker compose -f sync/docker-compose.yml up -d --wait
```

## Vérifier que tout fonctionne

**Grafana** : dans *Connections → Data sources*, ouvrir `Prometheus` puis `Jaeger` et cliquer sur **Test** : un message vert doit apparaître.

**Prometheus** : dans Grafana, *Explore* → source `Prometheus` → requête `up`. Les 6 cibles (5 services + rabbitmq) apparaissent ; elles valent 0 tant que les services ne tournent pas.

**Traces** : envoyer une trace de test au collecteur, puis la chercher dans Jaeger (http://localhost:16686, service `test-grafana`) ou dans Grafana (*Explore* → `Jaeger` → *Search*) :

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
sync/      variante synchrone (services/, lib/, docker-compose.yml)
async/     variante asynchrone (services/, lib/)
common/    éléments partagés, hors comparaison
  infra/     monitoring : Jaeger, OTel Collector, Prometheus, Grafana
  db/        schéma, données de départ, conteneur PostgreSQL commun
  benchmarks/, scripts/   (à venir)
docs/      decisions-conception.md : choix de conception et leur source
CLAUDE.md  règles du POC, état d'avancement réel
```

Les résultats des benchmarks vont dans `results/` (ignoré par git).

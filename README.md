# POC : communication synchrone vs asynchrone

Preuve de concept qui compare deux façons de faire communiquer les mêmes 5 microservices d'un flux e-commerce (`order`, `payment`, `inventory`, `shipping`, `notification`) :

- **`sync/`** : appels HTTP directs entre services (Fastify + undici) ;
- **`async/`** : échanges par messages via RabbitMQ (amqplib).

Les deux variantes partagent la même pile d'observabilité (traces, métriques) pour pouvoir être mesurées et comparées.

> **État actuel :** l'infrastructure et les dépendances sont en place, mais le code des services n'est pas encore écrit. Les étapes ci-dessous démarrent la pile d'observabilité ; le lancement des services sera ajouté ici au fur et à mesure.

## Prérequis

- [Node.js](https://nodejs.org/) 22 ou plus (la version est fixée dans `.nvmrc`)
- [Docker](https://docs.docker.com/get-docker/) avec Docker Compose

## Démarrage

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

Le fichier Compose utilise un réseau externe `poc-net`, qu'il faut créer une seule fois :

```bash
docker network create poc-net
```

### 4. Démarrer la pile d'observabilité

```bash
docker compose -f common/infra/docker-compose.yml up -d
```

| Outil | Adresse |
|---|---|
| Jaeger (traces) | http://localhost:16686 |
| Prometheus (métriques) | http://localhost:9090 |
| Grafana (tableaux de bord) | http://localhost:3100 |
| OTel Collector (réception OTLP/HTTP) | `localhost:4318` |

Pour arrêter la pile :

```bash
docker compose -f common/infra/docker-compose.yml down
```

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
sync/      variante synchrone (services/ et lib/)
async/     variante asynchrone (services/ et lib/)
common/    éléments partagés : infra/, db/, benchmarks/, scripts/
docs/      documentation
```

Les résultats des benchmarks vont dans `results/` (ignoré par git).

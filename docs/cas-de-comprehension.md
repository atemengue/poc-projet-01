# Cas de compréhension

Observations faites en regardant fonctionner le système, avec de quoi les rejouer.
Ce ne sont **pas des résultats de mesure** : ils servent à comprendre le comportement du système avant le banc d'essai.

Chaque cas suit le même plan : la question, l'explication simple, comment le rejouer, ce qu'on doit observer, et pourquoi ça compte pour le POC.

## Préparation (commune à tous les cas)

Toutes les commandes se lancent depuis la racine du dépôt.

```bash
# la pile doit tourner
docker compose -f common/infra/docker-compose.yml up -d
docker compose -f sync/docker-compose.yml up -d --wait

# fonction d'envoi : order <client> <articles> <jeton de carte>
order() { curl -s -w '  [HTTP %{http_code}, %{time_total}s]\n' -X POST localhost:3000/orders \
  -H 'content-type: application/json' -d "{\"customerId\":\"$1\",\"items\":$2,
  \"paymentInformation\":{\"cardToken\":\"$3\"},\"shippingAddress\":{\"city\":\"Montreal\"}}"; }
```

Dans un second terminal, suivre les logs (chaque ligne `order processed` donne `orderId` et `traceId`) :

```bash
docker compose -f sync/docker-compose.yml logs -f order --no-log-prefix
```

Requête pour lire l'état en base d'un groupe de clients (remplacer `cas-%` par le préfixe utilisé) :

```bash
docker compose -f sync/docker-compose.yml exec -T postgres psql -U poc -d poc -c "
SELECT o.customer_id client, o.status, o.payment_status pay, o.stock_status stock,
  coalesce((SELECT string_agg(p.status,',') FROM payments p WHERE p.order_id=o.id),'-') payments,
  (SELECT count(*) FROM shipments s WHERE s.order_id=o.id) ship,
  coalesce((SELECT string_agg(n.kind,',') FROM notifications n WHERE n.order_id=o.id),'-') notif,
  round(extract(epoch FROM o.accepted_at -o.received_at)*1000) acc_ms,
  round(extract(epoch FROM o.confirmed_at-o.received_at)*1000) conf_ms,
  round(extract(epoch FROM o.completed_at-o.received_at)*1000) compl_ms
FROM orders o WHERE o.customer_id LIKE 'cas-%' ORDER BY o.received_at;"
```

---

## C1 — Les parcours d'une commande et les pannes

*Observé le 2026-11-03, variante synchrone.*

**Question** : que retourne le système pour chaque parcours métier et chaque panne ?

**Rejouer** :

```bash
order cas1-a '[{"sku":"SKU-001","quantity":2}]' tok_ok         # parcours normal
order cas1-b '[{"sku":"SKU-002","quantity":1}]' tok_declined   # paiement refusé
order cas1-c '[{"sku":"SKU-LOW","quantity":51}]' tok_ok        # stock insuffisant

docker compose -f sync/docker-compose.yml stop shipping
order cas1-d '[{"sku":"SKU-003","quantity":1}]' tok_ok         # panne de Shipping
docker compose -f sync/docker-compose.yml start shipping

docker compose -f sync/docker-compose.yml stop payment
order cas1-e '[{"sku":"SKU-003","quantity":1}]' tok_ok         # panne de Payment
docker compose -f sync/docker-compose.yml start payment
```

**Observer** (réponse HTTP, puis état en base avec le préfixe `cas1-%`) :

| Cas | Réponse | État en base |
|---|---|---|
| a | `201 CONFIRMED`, `completed: true` | paiement `AUTHORIZED`, réservations, 1 expédition, notification `ORDER_CONFIRMED` |
| b | `201 REJECTED (PAYMENT_DECLINED)`, rapide | paiement `DECLINED`, aucune réservation, notification `ORDER_REJECTED` |
| c | `201 REJECTED (INSUFFICIENT_STOCK)` | paiement `VOIDED` (la compensation a eu lieu), aucune réservation |
| d | `201 CONFIRMED`, `completed: false` | confirmée, mais **ni expédition ni notification** |
| e | `502`, `status: RECEIVED` | bloquée, aucun paiement |

**Pourquoi ça compte** :
- d : la commande ne sera jamais terminée (aucune nouvelle tentative, SV7) et le client n'est pas notifié de sa confirmation. Question ouverte : faut-il notifier même si l'expédition échoue ?
- e : violation de I10 (commande non terminée). C'est ce que S4 mesurera, et c'est le cœur de H3 : en asynchrone, cette commande serait prise en compte et traitée après la reprise.

---

## C2 — Commande froide et commande chaude

*Observé le 2026-11-03, variante synchrone.*

**Question** : pourquoi la même commande prend-elle parfois 1,3 s et parfois 0,1 s ?

**Explication simple** :
- **Commande froide** : les services n'ont aucune connexion ouverte à la base (juste après un démarrage, ou après plus de 10 s sans commande). Chaque service doit en ouvrir une, ce qui coûte de 35 à 190 ms par service.
- **Commande chaude** : les connexions sont déjà ouvertes parce qu'une commande vient de passer ; les services les réutilisent immédiatement.

La commande est identique ; seul l'état des connexions change.

**Pourquoi ouvrir une connexion coûte cher** : connexion TCP, authentification SCRAM-SHA-256 (calcul volontairement coûteux, des deux côtés, sur des services limités à 1 CPU), création d'un processus côté PostgreSQL.

**Quand le pool doit-il ouvrir une connexion ?** Le pool `pg` de chaque service démarre vide, ferme toute connexion inactive depuis plus de 10 s (`idleTimeoutMillis` par défaut) et est propre à chaque service. Une commande « chaude » peut donc payer des connexions si plus de 10 s se sont écoulées depuis la précédente, ou si un service vient d'être redémarré.

**Rejouer** :

```bash
# attendre au moins 15 s sans rien envoyer, puis :
order cas2-froid '[{"sku":"SKU-001","quantity":1}]' tok_ok
for i in 1 2 3; do order cas2-chaud '[{"sku":"SKU-001","quantity":1}]' tok_ok; done
```

**Observer** :
- curl : la commande `cas2-froid` est nettement plus lente que les trois `cas2-chaud` (de l'ordre de 1 s contre 0,1 s).
- Jaeger (http://localhost:16686) : copier le `traceId` de chaque commande depuis les logs et le coller dans *Search by Trace ID*.
  - Deux spans à distinguer : `pg-pool.connect` (emprunter une connexion au pool, ~0,1 ms si une est libre) et `pg.connect` (ouvrir une nouvelle connexion, 30 à 200 ms, placé sous le précédent).
  - Trace froide : un `pg.connect` long dans chaque service.
  - Trace chaude : plus de `pg.connect` ; le temps est presque entièrement celui des latences simulées (Payment ~50 ms, Inventory ~10 ms, Shipping ~20 ms, Notification ~10 ms).
- Si une trace « chaude » montre encore des `pg.connect`, regarder dans quels services et l'écart avec la commande précédente : plus de 10 s, ou service redémarré juste avant.

**Pourquoi ça compte** :
- En régime établi (S1, S2), les connexions ne restent jamais inactives 10 s : l'effet disparaît après le préchauffage, qui est donc indispensable.
- Il réapparaît dès qu'il y a des pauses : panne de 30 s en S4, faible débit en S5. Ces pics viennent de la gestion du pool, pas du style d'architecture.
- Pistes, à appliquer à l'identique dans A et B : allonger `idleTimeoutMillis`, garder un minimum de connexions ouvertes, ou s'appuyer seulement sur le préchauffage. Décision à consigner dans `docs/decisions-conception.md`.

---

## C3 — `received_at` est écrit trop tard

*Observé le 2026-11-03, variante synchrone. Défaut de mesure, non corrigé à cette date.*

**Question** : pourquoi la latence calculée depuis la base est-elle plus courte que celle vue par le client ?

**Explication simple** : `received_at` est écrit au moment où la commande est insérée en base, donc **après** l'attente d'une connexion au pool et la lecture des prix. Ce temps d'attente n'est pas compté dans les latences calculées depuis la base.

**Rejouer** : reprendre C2 (commande froide), puis lire l'état en base avec le préfixe `cas2-%`.

**Observer** : pour `cas2-froid`, `compl_ms` (base) est nettement inférieur au temps affiché par curl. Observé : 846 ms en base pour 1 338 ms côté client, soit environ 490 ms invisibles (ouverture de connexion et lecture des prix).

**Pourquoi ça compte** : sous forte charge (S2), l'attente du pool est précisément ce qui grandit quand le système sature. Avec ce défaut, la dégradation serait sous-estimée dans A comme dans B, peut-être pas dans les mêmes proportions : H1 et H2 sont directement concernées.

**Correctif proposé** (à discuter) : noter l'heure d'arrivée de la requête dès son entrée dans Order et l'écrire dans `received_at` (modification de `domain.js`, donc commune à A et B), et garder la latence mesurée côté client par k6 comme contrôle.

---

## C4 — La métrique `up` de Prometheus

*Observé le 2026-11-03, variante synchrone.*

**Question** : que veut dire la requête `up`, et comment la lancer ?

**Explication simple** : `up` est une métrique **fabriquée par Prometheus lui-même**, pas envoyée par les services. Toutes les 5 s, Prometheus lit la page `/metrics` de chaque cible déclarée dans `common/infra/prometheus.yml` (`order:3000`, `payment:3001`…) et note :
- `up = 1` : la lecture a réussi, le service répond ;
- `up = 0` : la lecture a échoué (service arrêté, injoignable ou trop lent).

Il y a une courbe par cible, repérée par ses étiquettes `job` et `instance` (ex. `instance="payment:3001"`).

**Lancer la requête** (au choix) :
- **Prometheus** : http://localhost:9090 → taper `up` → **Execute** ; onglet *Table* pour la valeur actuelle, *Graph* pour la courbe.
- **Grafana** : http://localhost:3100 (`admin` / `admin`) → **Explore** → source **Prometheus** → mode **Code** → taper `up` → **Run query**.
- **Terminal** :

  ```bash
  curl -s 'localhost:9090/api/v1/query?query=up' | python3 -c 'import sys,json;[print(r["metric"]["instance"],r["value"][1]) for r in json.load(sys.stdin)["data"]["result"]]'
  ```

**Rejouer** :

```bash
docker compose -f sync/docker-compose.yml stop payment
# attendre 5 à 10 s, relancer la requête up
docker compose -f sync/docker-compose.yml start payment
# attendre 5 à 10 s, relancer la requête up
```

**Observer** :
- avant l'arrêt : les 5 services à 1, `rabbitmq:15692` à 0 (RabbitMQ n'existe que dans la variante asynchrone) ;
- après l'arrêt : `payment:3001` passe à 0 ; dans l'onglet *Graph*, la courbe descend puis remonte au redémarrage.

**Pourquoi ça compte** :
- `up = 1` signifie seulement que le service répond à `/metrics`, **pas** que les commandes passent : si PostgreSQL tombait, les services resteraient à 1.
- En S4 (Payment arrêté 30 s), la courbe `up` de Payment date précisément la fenêtre de panne, ce qui sert à lire les autres métriques sur la même période.

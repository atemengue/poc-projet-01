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

# fonction d'envoi : order <client> <SKU> <quantité> <jeton de carte>
order() { curl -s -w '  [HTTP %{http_code}, %{time_total}s]\n' -X POST localhost:3000/orders \
  -H 'content-type: application/json' -d "{\"customerId\":\"$1\",\"items\":[\"$2\"],\"quantity\":$3,
  \"paymentInformation\":{\"cardToken\":\"$4\"},\"shippingAddress\":{\"city\":\"Montreal\"}}"; }
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
order cas1-a SKU-001 2 tok_ok         # parcours normal
order cas1-b SKU-002 1 tok_declined   # paiement refusé
order cas1-c SKU-LOW 51 tok_ok        # stock insuffisant

docker compose -f sync/docker-compose.yml stop shipping
order cas1-d SKU-003 1 tok_ok         # panne de Shipping
docker compose -f sync/docker-compose.yml start shipping

docker compose -f sync/docker-compose.yml stop payment
order cas1-e SKU-003 1 tok_ok         # panne de Payment
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
order cas2-froid SKU-001 1 tok_ok
for i in 1 2 3; do order cas2-chaud SKU-001 1 tok_ok; done
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

*Observé le 2026-11-03, variante synchrone. **Défaut de mesure corrigé le 2026-11-03** (voir « Correctif appliqué »).*

**Question** : pourquoi la latence calculée depuis la base est-elle plus courte que celle vue par le client ?

### À quoi sert `received_at`

Toutes les latences du POC sont calculées **depuis la base** (règle d'équité, CLAUDE.md §6), par soustraction d'horodatages :

| Latence | Calcul |
|---|---|
| acceptation (critère p95 < 1 s, A-12) | `accepted_at − received_at` |
| confirmation | `confirmed_at − received_at` |
| complétion | `completed_at − received_at` |

`received_at` est le **point de départ du chronomètre** : il doit marquer l'instant où la commande arrive dans le système. S'il est noté trop tard, toutes les latences paraissent plus courtes qu'en réalité.

### Ce que faisait le code (avant correctif)

Dans `sync/services/order/server.js`, `POST /orders` exécute dans l'ordre :

```
 t=0      la requête arrive dans Order          ← le client attend depuis ici
   │
   ├─ 1. validation de la requête                (rapide)
   ├─ 2. attendre une connexion libre au pool    ← peut être long
   ├─ 3. lire les prix dans products             (requête SQL)
   ├─ 4. attendre une connexion pour la transaction
   │
 t=?      INSERT INTO orders … received_at = now()   ← le chronomètre démarre ICI
   │
   ├─ appel Payment    → accepted_at
   ├─ appel Inventory  → confirmed_at
   └─ appels Shipping + Notification → completed_at
```

`received_at` prend la valeur par défaut `now()` de la colonne (`common/db/schema.sql`) au moment de l'INSERT fait par `createOrder` (`order/domain.js`). Tout ce qui précède (étapes 1 à 4) **n'est pas compté**.

### Ce qu'on a observé

Commande froide (voir C2) :

| Mesure | Valeur |
|---|---|
| attente vue par le client (curl) | 1 338 ms |
| `completed_at − received_at` en base | 846 ms |
| temps invisible | ≈ 490 ms (ouverture de connexion ≈ 250 ms, lecture des prix ≈ 100 ms, reste) |

À chaud, l'écart n'est que de quelques millisecondes, d'où le fait qu'il soit passé inaperçu.

### Pourquoi c'est grave pour le POC

Le cas froid n'est qu'un symptôme. Le vrai problème apparaît **sous forte charge** :

- à 500 cmd/s (S2), si Order sature, les requêtes **font la queue** pour obtenir une connexion au pool (étape 2) ;
- ce temps de file d'attente est précisément **ce qui grandit quand le système se dégrade** ;
- avec le code actuel, il se situe **avant** `received_at`, donc il est invisible : la base pourrait indiquer « p95 = 300 ms » alors que les clients attendent plusieurs secondes.

La dégradation serait sous-estimée, et pas forcément de la même façon dans A et B : en A, la requête HTTP reste ouverte pendant toute la file d'attente ; en B, Order répond `202` après l'INSERT, mais peut aussi faire la queue avant. **H1** (débit sous charge) et **H2** (latence) sont directement concernées.

### Rejouer

```bash
# attendre au moins 15 s sans rien envoyer (commande froide, voir C2), puis :
order cas3-froid SKU-001 1 tok_ok
```

Lire l'état en base avec le préfixe `cas3-%` (requête de la section Préparation).

**Observer** : `compl_ms` (base) doit être presque égal au temps affiché par curl (quelques millisecondes d'écart : envoi de la réponse après `completed_at`). Avant le correctif, il était nettement inférieur sur une commande froide.

### Correctif appliqué (2026-11-03)

L'heure est notée **dès l'arrivée de la requête** et écrite dans `received_at` :

```
 t=0      la requête arrive → receivedAt = new Date()   ← le chronomètre démarre ICI
   ├─ validation, pool, prix, …
   └─ INSERT INTO orders … received_at = $receivedAt
```

- `order/server.js` note `req.receivedAt` dans un hook `onRequest` de la route `POST /orders`, le tout premier point d'entrée de Fastify (avant la lecture du corps), puis le transmet ;
- `order/domain.js` (`createOrder`) écrit `received_at = $receivedAt` au lieu de la valeur par défaut `now()`, et **refuse** d'insérer sans instant valide. `domain.js` étant commun à A et B, les deux variantes mesureront de la même façon ;
- deux tests (`sync/test/domain.test.js`) : l'instant fourni est bien celui écrit, et aucun INSERT ne part sans instant valide.

**Vérification après correctif** (services redémarrés, donc première commande froide) :

| Commande | curl | base (`compl_ms`) | écart |
|---|---|---|---|
| froide | 246 ms | 242 ms | 4 ms |
| chaudes (×3) | 121 / 121 / 138 ms | 119 / 118 / 133 ms | 2 à 5 ms |

Avant correctif, l'écart sur une commande froide était d'environ 490 ms.

**Limites du correctif** :
- **Horloges** : `receivedAt` vient de l'horloge du conteneur Order, les autres horodatages de celle de PostgreSQL. Sur un seul hôte (A-15), ils partagent l'horloge système : pas de décalage significatif. Sur plusieurs machines, ce serait un vrai problème.
- **Ce qui reste invisible** : le temps passé *avant* que la requête atteigne Order (réseau, file d'attente du système si Order est saturé à 100 % CPU). D'où le contrôle par la **latence mesurée côté client par k6** : si elle diverge fortement de la latence en base, la saturation se situe avant Order.

`async/` devra reprendre le même mécanisme côté transport : noter `receivedAt` à l'arrivée de la requête et le passer à `createOrder` (que `domain.js` impose).

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

---

## C5 — Où sature le synchrone

*Observé le 2026-11-07, variante synchrone, essai à blanc `dry-sync-02` (jamais cité dans l'ADR).*

**Question** : à partir de quelle charge `sync/` ne suit plus, et pourquoi ?

**Explication simple** : en synchrone, Order fait tout le travail pour chaque commande : il reçoit la requête, interroge la base (environ 8 requêtes), appelle les quatre services l'un après l'autre et attend leurs réponses, en produisant les spans de trace de tout cela. Il n'a qu'un CPU. Vers 250 à 300 cmd/s, ce CPU est plein : les nouvelles commandes attendent leur tour dans la boucle d'événements d'Order, **avant** les appels sortants (d'où l'absence de timeout à 5 s), et la latence passe de quelques dizaines de millisecondes à plusieurs secondes. Il n'y a aucune erreur : le système ne casse pas, il fait attendre.

**Rejouer** (environ 5 min 30 ; le `reset` efface toutes les commandes) :

```bash
K6=grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8
RUN=cas5-01
OUT=results/dry-run/sync/$RUN && mkdir -p $OUT

(cd common && npm run reset)

docker run --rm --network poc-net \
  -v "$PWD/common/benchmarks:/scripts:ro" -v "$PWD/results:/results" \
  -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
  -e K6_PROMETHEUS_RW_TREND_STATS='p(50),p(95),p(99),avg,max' \
  $K6 run -o experimental-prometheus-rw --tag testid=$RUN \
  -e RUN_ID=$RUN -e PROFILE=steps \
  --summary-export=/results/dry-run/sync/$RUN/k6-summary.json /scripts/place-order.js

(cd common && npm run verify)
node common/scripts/latency.js --run $RUN --slice 60
```

Pendant le run : Grafana → **POC — Run k6 et services** (run `cas5-01`), et dans un second terminal `docker stats $(docker compose -f sync/docker-compose.yml ps -q)`.

Paliers du profil `steps` : 30 s à 50 cmd/s, puis 1 min à 100, 200, 300, 400 et 500 cmd/s. Les tranches de 60 s de `latency.js` sont décalées de 30 s par rapport aux paliers.

**Observer** (valeurs de `dry-sync-02`) :

| Tranche | Charge envoyée | Reçu/s | p95 acceptation | Lecture |
|---|---|---|---|---|
| 0–60 s | 50 → 100 | 73 | 68 ms | à l'aise |
| 60–120 s | 100 → 200 | 146 | 78 ms | à l'aise |
| 120–180 s | 200 → 300 | 245 | 566 ms | début de saturation |
| 180–240 s | 300 → 400 | 297 | 4,3 s | saturé |
| 240–300 s | 400 → 500 | 255 | 10,3 s | saturé, le débit reçu baisse |

- **Grafana, CPU par service** : Order proche de 100 % (sa limite d'un CPU) ; les autres restent sous 40 %.
- **Boucle d'événements d'Order** : pics jusqu'à environ 550 ms.
- **VUs k6** : plafond de 3 000 atteint ; **itérations perdues** : 21 204 (23 %).
- **Statuts HTTP** : 100 % de `201`, aucun `502`.
- **`verify`** : OK sur I1 à I11 (toutes les commandes terminées).

**Pourquoi ça compte** :
- **H1** : capacité de `sync/` sur ce banc d'essai d'environ 250 à 300 cmd/s ; au-delà, le seuil p95 < 1 s n'est plus tenu. Repère pour l'événementiel, pas une preuve (essai à blanc).
- **Équité** : le goulot est dans Order parce qu'il orchestre. En chorégraphie, ce travail sera réparti entre les services ; une partie de l'écart mesuré viendra donc de l'orchestration, pas seulement de la communication (menace à la validité, `docs/hypotheses-assumption.md` §7).
- **Protocole** : au-delà de la saturation, le plafond de VUs bride k6 (loi de Little : 300 cmd/s × 10 s ≈ 3 000 requêtes en vol). Le débit reçu baisse alors que la charge prévue monte : la charge n'est plus réellement ouverte, et la règle « ≥ 1 % d'itérations perdues = run invalide » pénaliserait le banc d'essai plutôt que le système. Décision à prendre avant S2.
- **Piège de lecture Grafana** : après la fin d'un run, les courbes k6 restent plates pendant environ 5 min. Ce n'est pas une mesure : Prometheus renvoie la dernière valeur reçue tant que la série n'a pas expiré.

# Décisions de conception

Chaque décision indique sa source : **Énoncé**, **Responsable** (décidé par le responsable du projet) ou **Proposition** (proposée par Claude, à valider). Une proposition non validée peut être remise en cause sans autre justification.

## Base de données (étape 1, 2026-11-02)

| # | Décision | Source |
|---|---|---|
| DB1 | PostgreSQL 17, SQL explicite via `pg`, pas d'ORM. | Énoncé / CLAUDE.md |
| DB2 | Une seule base partagée par les 5 services et un schéma unique pour A et B (`common/db/schema.sql`). Limite assumée : la base commune peut masquer l'effet du style (CLAUDE.md §13). | Énoncé (même schéma) + Proposition (base unique) |
| DB3 | La définition du conteneur PostgreSQL vit dans `common/db/postgres.compose.yml`, incluse par `sync/` et `async/` (`include:` de Compose) : impossible que les deux variantes divergent sur la base. Chaque projet garde son propre volume. | Proposition |
| DB4 | `orders` porte des copies `payment_status` et `stock_status`, lues par la requête d'invariant unique (CLAUDE.md §5). | Énoncé (requête d'invariant) |
| DB5 | **Pas de contrainte CHECK « CONFIRMED ⇒ AUTHORIZED ∧ RESERVED »** en base. Une telle contrainte rendrait toute violation impossible et masquerait ce que l'on veut observer (une violation est un résultat à documenter). La détection revient à `verify-invariants.js`. | Proposition |
| DB6 | **Pas d'unicité sur `order_id`** dans `payments`, `stock_reservations`, `shipments`, `notifications` : un effet de bord dupliqué (S5, idempotence désactivée) doit rester visible et comptable (`side_effects_duplicated_total`). L'idempotence est assurée par `idempotency_keys` (sync) et `processed_events` (async), pas par le schéma. | Proposition |
| DB7 | `products.stock` = quantité disponible, avec `CHECK (stock >= 0)` : une réservation au-delà du stock échoue en base (garde-fou métier, identique pour A et B). | Proposition |
| DB8 | Table `outbox` présente dans le schéma commun bien que seule `async/` l'utilise, pour garder un schéma unique. | Proposition (D3 = outbox par défaut) |
| DB9 | Données de départ : 5 SKU à 1 000 000 d'unités et `SKU-LOW` à 50 unités pour provoquer la compensation (void du paiement). La valeur 50 est à ajuster selon la durée des scénarios et D12. | Proposition |
| DB10 | Ressources PostgreSQL : 2 CPU / 1 Go, `max_connections=200`, identiques pour A et B. La limite « 1 CPU / 512 Mo » de l'énoncé vise les services. | Proposition |
| DB11 | PostgreSQL exposé sur le port hôte **55432** (5432 souvent occupé par une installation locale). Dans `poc-net`, les services utilisent `postgres:5432`. | Proposition |
| DB12 | Pool `pg` laissé à ses réglages par défaut : connexions ouvertes à la demande et fermées après 10 s d'inactivité (`idleTimeoutMillis`). Pas de connexions maintenues ouvertes artificiellement : la phase de préchauffage du protocole absorbe l'effet en régime établi (S1, S2). Conséquence assumée : après toute pause de plus de 10 s (panne de S4, faible débit de S5), les premières commandes paient l'ouverture des connexions (35 à 190 ms par service, cas C2). Effet identique dans A et B, dû au pool et non au style ; à rappeler lors de la lecture de S4 et S5. | Proposition |

## Services synchrones (étape 2, 2026-11-02)

| # | Décision | Source |
|---|---|---|
| SV1 | Chaque service sépare `domain.js` (validation, SQL métier, requête d'invariant, décision de paiement, latence simulée par défaut : identique dans A et B) et `server.js` / `workflow.js` (transport : propre à chaque variante). Les fonctions de `domain.js` reçoivent un client pg et ne gèrent jamais la transaction, pour que `async/` puisse y ajouter `processed_events` et `outbox`. | Proposition (règle de parité de l'énoncé) |
| SV2 | Order lit les prix directement dans `products` (lecture seule, identique dans A et B) plutôt que d'appeler Inventory : un appel synchrone de prix dans la chorégraphie de B fausserait la comparaison. | Proposition |
| SV3 | Le refus de paiement est déterministe : `paymentInformation.cardToken = "tok_declined"`. k6 maîtrise ainsi le taux de refus (D12). | Proposition |
| SV4 | Latences simulées par défaut : Payment 50 ms, Inventory 10 ms, Shipping 20 ms, Notification 10 ms (surcharge : `SIMULATED_LATENCY_MS`). Valeurs inventées, à remplacer si l'énoncé ou le responsable en donnent. | Proposition |
| SV5 | Requête : `items: [{ sku, quantity }]` (une quantité par article), SKU en double refusé. | Proposition (interprétation de l'énoncé) |
| SV6 | `POST /orders` en synchrone répond après le workflow complet : `201` si la commande atteint `CONFIRMED` ou `REJECTED`, `502` si une dépendance échoue avant (la commande reste `RECEIVED` ou `ACCEPTED`). Échec de Shipping/Notification après confirmation : `201` avec `completed: false`. | Proposition |
| SV7 | Aucune nouvelle tentative ni compensation technique en cas de panne (règle d'équité). Une panne d'Inventory après paiement autorisé laisse la commande `ACCEPTED` avec un paiement non annulé (violation de I10 attendue en S4). | Énoncé (équité) + Proposition |
| SV8 | Appels sortants : délai maximal 5 s (`OUTBOUND_TIMEOUT_MS`), pool undici de 64 connexions par origine (`OUTBOUND_CONNECTIONS`). | Proposition |
| SV9 | Le void du paiement se fait par commande (`POST /payments/void { orderId }`) et annule **tous** ses paiements autorisés, ce qui couvre aussi les doublons (I4). | Proposition |
| SV10 | Réservation de stock tout ou rien dans une transaction, avec un SAVEPOINT pour annuler une réservation partielle, et verrouillage des SKU dans un ordre fixe pour éviter les interblocages. | Proposition |
| SV11 | Une seule image Docker pour les 5 services (`node:22.22.2-slim` figée), 1 CPU / 512 Mo chacun, pool pg de 20 connexions par service. | Énoncé (ressources) + Proposition |
| SV12 | OpenTelemetry (traces HTTP, undici, pg ; `traceId` dans les logs pino) et métriques Node par défaut sur `/metrics` dès l'étape 2. Les métriques de l'étape 7 restent à faire. | Proposition |
| SV13 | `received_at` = instant d'arrivée de la requête, noté par le transport au premier point d'entrée (hook `onRequest`) et imposé par `createOrder`, au lieu de `now()` à l'INSERT. Sans cela, l'attente du pool et la lecture des prix sont invisibles dans les latences calculées depuis la base, ce qui sous-estime la dégradation sous charge (cas C3). Horloges du conteneur Order et de PostgreSQL : même hôte, pas de décalage significatif. La latence côté client (k6) reste un contrôle. | Proposition (correction d'un défaut de mesure) |

## Vérification des invariants (étape 3, 2026-11-03)

| # | Décision | Source |
|---|---|---|
| VI1 | Colonne `products.initial_stock`, remplie par `seed.sql`, pour vérifier I6 sans relire `seed.sql`. Les bases créées avant reçoivent la colonne par un `ALTER TABLE … ADD COLUMN IF NOT EXISTS` dans `schema.sql` ; lancer ensuite `npm run reset`. | Proposition (validée le 2026-11-03) |
| VI2 | Codes de sortie de `verify-invariants.js` : `0` ok, `1` violations (résultat, le run reste valide), `2` inconclusive. | Proposition (validée le 2026-11-03) |
| VI3 | Une base sans aucune commande donne `2` (inconclusive) : une vérification qui ne porte sur rien ne prouve rien (CLAUDE.md §8 : une mesure manquante n'est jamais un succès implicite). | Proposition |
| VI4 | Le drainage n'est pas géré par le vérificateur mais par `run-scenario.js` (étape 7) ; le rapport rappelle que I10 et I11 n'ont de sens qu'après drainage. | Proposition (validée le 2026-11-03) |
| VI5 | Test du vérificateur : une violation injectée par règle, plus deux témoins cohérents, chacun dans une transaction annulée (`ROLLBACK`) : le test tourne sur la base du POC sans la modifier ni dépendre de son contenu. | Proposition (validée le 2026-11-03) |
| VI6 | I7 compte toute ligne de paiement en double, quel que soit son statut (et non seulement les paiements autorisés) : deux lignes signifient deux appels au prestataire. | Proposition |
| VI7 | `reset.js` refuse de vider une base qui ne s'appelle pas `poc` ou `poc_*`. | Proposition |

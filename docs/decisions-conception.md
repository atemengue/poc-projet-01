# Décisions de conception

Chaque décision indique sa source : **Énoncé**, **Régis** (décidé par Régis) ou **Proposition** (proposée par Claude, à valider). Une proposition non validée peut être remise en cause sans autre justification.

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

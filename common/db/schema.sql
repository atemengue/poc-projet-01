-- Schéma commun aux variantes sync/ et async/ (règle d'équité : même schéma).
-- Chargé automatiquement au premier démarrage du volume PostgreSQL ; réexécutable.
-- Une seule base partagée par les 5 services (limite connue du rig, cf. CLAUDE.md §13).

-- ---------------------------------------------------------------- Order
CREATE TABLE IF NOT EXISTS orders (
  id                 uuid PRIMARY KEY,
  customer_id        text        NOT NULL,
  status             text        NOT NULL DEFAULT 'RECEIVED'
                     CHECK (status IN ('RECEIVED', 'ACCEPTED', 'CONFIRMED', 'REJECTED')),
  -- Copies locales, lues par la requête d'invariant (un seul point de confirmation).
  payment_status     text        NOT NULL DEFAULT 'PENDING'
                     CHECK (payment_status IN ('PENDING', 'AUTHORIZED', 'DECLINED', 'VOIDED')),
  stock_status       text        NOT NULL DEFAULT 'PENDING'
                     CHECK (stock_status IN ('PENDING', 'RESERVED', 'INSUFFICIENT')),
  rejection_reason   text        CHECK (rejection_reason IN ('PAYMENT_DECLINED', 'INSUFFICIENT_STOCK')),
  total_cents        integer     NOT NULL CHECK (total_cents >= 0),
  payment_info       jsonb       NOT NULL,
  shipping_address   jsonb       NOT NULL,
  idempotency_key    text        UNIQUE,          -- en-tête Idempotency-Key (sync, S5)
  -- Horodatages : source unique des latences, mêmes requêtes pour A et B.
  received_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz,                 -- paiement autorisé
  confirmed_at       timestamptz,                 -- invariant satisfait
  completed_at       timestamptz,                 -- expédition demandée + notification envoyée
  rejected_at        timestamptz
);
-- Pas de CHECK « CONFIRMED ⇒ AUTHORIZED ∧ RESERVED » : une violation d'invariant doit
-- rester observable (c'est un résultat), elle est détectée par verify-invariants.js.

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

CREATE TABLE IF NOT EXISTS order_items (
  order_id          uuid    NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  sku               text    NOT NULL,
  quantity          integer NOT NULL CHECK (quantity > 0),
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  PRIMARY KEY (order_id, sku)
);

-- ---------------------------------------------------------------- Payment (simulateur)
-- Pas d'unicité sur order_id : une double autorisation (S5) doit être visible et comptée.
CREATE TABLE IF NOT EXISTS payments (
  id             uuid PRIMARY KEY,
  order_id       uuid        NOT NULL,
  amount_cents   integer     NOT NULL CHECK (amount_cents >= 0),
  status         text        NOT NULL CHECK (status IN ('AUTHORIZED', 'DECLINED', 'VOIDED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz
);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);

-- ---------------------------------------------------------------- Inventory
CREATE TABLE IF NOT EXISTS products (
  sku          text PRIMARY KEY,
  price_cents  integer NOT NULL CHECK (price_cents >= 0),
  stock        integer NOT NULL CHECK (stock >= 0)   -- quantité disponible (déjà déduite des réservations)
);

-- Pas d'unicité sur order_id : une double réservation (S5) doit être visible et comptée.
CREATE TABLE IF NOT EXISTS stock_reservations (
  id          uuid PRIMARY KEY,
  order_id    uuid        NOT NULL,
  sku         text        NOT NULL REFERENCES products (sku),
  quantity    integer     NOT NULL CHECK (quantity > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_reservations_order_idx ON stock_reservations (order_id);

-- ---------------------------------------------------------------- Shipping
CREATE TABLE IF NOT EXISTS shipments (
  id          uuid PRIMARY KEY,
  order_id    uuid        NOT NULL,
  address     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipments_order_idx ON shipments (order_id);

-- ---------------------------------------------------------------- Notification
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY,
  order_id    uuid        NOT NULL,
  kind        text        NOT NULL,                -- ex. ORDER_CONFIRMED, ORDER_REJECTED
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_order_idx ON notifications (order_id);

-- ---------------------------------------------------------------- Idempotence
-- sync/ : réponse mémorisée par (service, Idempotency-Key), pour les retries clients (S5).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  service     text        NOT NULL,
  key         text        NOT NULL,
  response    jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, key)
);

-- async/ : événements déjà traités, écrits dans la même transaction que l'effet métier.
CREATE TABLE IF NOT EXISTS processed_events (
  consumer      text        NOT NULL,
  event_id      uuid        NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- async/ : outbox transactionnel (D3). Inutilisé par sync/, présent pour garder un schéma unique.
CREATE TABLE IF NOT EXISTS outbox (
  id            uuid PRIMARY KEY,                  -- = eventId de l'enveloppe
  aggregate_id  uuid        NOT NULL,              -- orderId
  type          text        NOT NULL,
  payload       jsonb       NOT NULL,
  headers       jsonb       NOT NULL DEFAULT '{}', -- dont traceparent
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;

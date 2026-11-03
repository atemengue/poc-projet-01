// Règles I1 à I11 (docs/invariants.md), chacune exprimée comme une requête SQL qui renvoie
// les lignes EN INFRACTION. Aucune ligne = règle respectée.
// Chaque ligne a une colonne `key` (orderId, ou sku pour I6) et des colonnes de détail.

export const CHECKS = [
  // ------------------------------------------------------------------ sûreté
  {
    id: 'I1',
    family: 'safety',
    title: 'commande confirmée sans paiement autorisé et stock réservé',
    sql: `
      SELECT id::text AS key, payment_status, stock_status
        FROM orders
       WHERE status = 'CONFIRMED'
         AND (payment_status <> 'AUTHORIZED' OR stock_status <> 'RESERVED')`,
  },
  {
    id: 'I2',
    family: 'safety',
    title: 'commande confirmée sans exactement un paiement autorisé du bon montant',
    sql: `
      SELECT o.id::text AS key,
             count(p.id) FILTER (WHERE p.status = 'AUTHORIZED') AS authorized,
             count(p.id) FILTER (WHERE p.status = 'AUTHORIZED' AND p.amount_cents = o.total_cents) AS authorized_right_amount
        FROM orders o
        LEFT JOIN payments p ON p.order_id = o.id
       WHERE o.status = 'CONFIRMED'
       GROUP BY o.id
      HAVING count(p.id) FILTER (WHERE p.status = 'AUTHORIZED') <> 1
          OR count(p.id) FILTER (WHERE p.status = 'AUTHORIZED' AND p.amount_cents = o.total_cents) <> 1`,
  },
  {
    id: 'I3',
    family: 'safety',
    title: 'commande confirmée dont les réservations ne correspondent pas aux articles',
    sql: `
      WITH r AS (
        SELECT order_id, sku, count(*) AS n, sum(quantity) AS qty
          FROM stock_reservations GROUP BY order_id, sku
      )
      SELECT o.id::text AS key, i.sku, i.quantity AS ordered, r.n AS reservations, r.qty AS reserved
        FROM orders o
        JOIN order_items i ON i.order_id = o.id
        LEFT JOIN r ON r.order_id = o.id AND r.sku = i.sku
       WHERE o.status = 'CONFIRMED'
         AND (r.n IS DISTINCT FROM 1 OR r.qty IS DISTINCT FROM i.quantity)
      UNION ALL
      SELECT o.id::text, r.sku, NULL, r.n, r.qty
        FROM orders o
        JOIN r ON r.order_id = o.id
       WHERE o.status = 'CONFIRMED'
         AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.sku = r.sku)`,
  },
  {
    id: 'I4',
    family: 'safety',
    title: 'rejet pour stock insuffisant avec un paiement encore autorisé (compensation non faite)',
    sql: `
      SELECT o.id::text AS key, count(p.id) AS authorized_payments
        FROM orders o
        JOIN payments p ON p.order_id = o.id AND p.status = 'AUTHORIZED'
       WHERE o.status = 'REJECTED' AND o.rejection_reason = 'INSUFFICIENT_STOCK'
       GROUP BY o.id`,
  },
  {
    id: 'I5',
    family: 'safety',
    title: 'rejet pour paiement refusé avec une réservation ou une expédition',
    sql: `
      SELECT o.id::text AS key,
             (SELECT count(*) FROM stock_reservations r WHERE r.order_id = o.id) AS reservations,
             (SELECT count(*) FROM shipments s WHERE s.order_id = o.id) AS shipments
        FROM orders o
       WHERE o.status = 'REJECTED' AND o.rejection_reason = 'PAYMENT_DECLINED'
         AND (EXISTS (SELECT 1 FROM stock_reservations r WHERE r.order_id = o.id)
              OR EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id))`,
  },
  {
    id: 'I6',
    family: 'safety',
    title: 'stock non conservé (stock initial − réservations ≠ stock actuel)',
    sql: `
      SELECT p.sku AS key, p.initial_stock, coalesce(r.reserved, 0) AS reserved, p.stock,
             p.initial_stock - coalesce(r.reserved, 0) AS expected_stock
        FROM products p
        LEFT JOIN (SELECT sku, sum(quantity) AS reserved FROM stock_reservations GROUP BY sku) r
               ON r.sku = p.sku
       WHERE p.stock <> p.initial_stock - coalesce(r.reserved, 0) OR p.stock < 0`,
  },
  {
    id: 'I7',
    family: 'safety',
    title: 'effet de bord dupliqué (paiement, réservation, expédition ou notification en double)',
    sql: `
      SELECT order_id::text AS key, 'payment' AS effect, NULL AS detail, count(*) AS n
        FROM payments GROUP BY order_id HAVING count(*) > 1
      UNION ALL
      SELECT order_id::text, 'reservation', sku, count(*)
        FROM stock_reservations GROUP BY order_id, sku HAVING count(*) > 1
      UNION ALL
      SELECT order_id::text, 'shipment', NULL, count(*)
        FROM shipments GROUP BY order_id HAVING count(*) > 1
      UNION ALL
      SELECT order_id::text, 'notification', kind, count(*)
        FROM notifications GROUP BY order_id, kind HAVING count(*) > 1`,
  },
  {
    id: 'I8',
    family: 'safety',
    title: 'expédition pour une commande non confirmée',
    sql: `
      SELECT s.order_id::text AS key, coalesce(o.status, 'INCONNUE') AS order_status
        FROM shipments s
        LEFT JOIN orders o ON o.id = s.order_id
       WHERE o.id IS NULL OR o.status <> 'CONFIRMED'`,
  },
  {
    id: 'I9',
    family: 'safety',
    title: 'horodatages incohérents avec l\'état',
    sql: `
      SELECT id::text AS key, status, problem FROM (
        SELECT id, status, CASE
          WHEN accepted_at  < received_at  THEN 'accepted_at < received_at'
          WHEN confirmed_at < accepted_at  THEN 'confirmed_at < accepted_at'
          WHEN completed_at < confirmed_at THEN 'completed_at < confirmed_at'
          WHEN status IN ('ACCEPTED', 'CONFIRMED') AND accepted_at IS NULL THEN 'accepted_at manquant'
          WHEN status = 'CONFIRMED' AND confirmed_at IS NULL THEN 'confirmed_at manquant'
          WHEN status = 'REJECTED'  AND rejected_at  IS NULL THEN 'rejected_at manquant'
          WHEN completed_at IS NOT NULL AND status <> 'CONFIRMED' THEN 'completed_at sur une commande non confirmée'
        END AS problem
        FROM orders
      ) t WHERE problem IS NOT NULL`,
  },

  // ------------------------------------------------------------------ vivacité (après drainage)
  {
    id: 'I10',
    family: 'liveness',
    title: 'commande non terminée (encore RECEIVED ou ACCEPTED)',
    sql: `
      SELECT id::text AS key, status, payment_status
        FROM orders
       WHERE status IN ('RECEIVED', 'ACCEPTED')`,
  },
  {
    id: 'I11',
    family: 'liveness',
    title: 'commande confirmée jamais terminée (expédition ou notification manquante)',
    sql: `
      SELECT id::text AS key,
             (SELECT count(*) FROM shipments s WHERE s.order_id = o.id) AS shipments,
             (SELECT count(*) FROM notifications n WHERE n.order_id = o.id AND n.kind = 'ORDER_CONFIRMED') AS notifications
        FROM orders o
       WHERE status = 'CONFIRMED' AND completed_at IS NULL`,
  },
];

/** Exécute toutes les règles. Retourne { ordersByStatus, totalOrders, results }. */
export async function runChecks(client) {
  const { rows: counts } = await client.query(
    'SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY status',
  );
  const ordersByStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  const totalOrders = counts.reduce((s, r) => s + r.n, 0);

  const results = [];
  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql);
    const keys = [...new Set(rows.map((r) => r.key))];
    results.push({
      id: check.id,
      family: check.family,
      title: check.title,
      violations: keys.length,
      keys,
      rows,
    });
  }
  return { ordersByStatus, totalOrders, results };
}

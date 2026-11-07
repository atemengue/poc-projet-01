// Domaine Order. Copie identique dans sync/ et async/ (règle de parité, CLAUDE.md §3).
// Aucune notion de transport ici. `db` est un pool ou un client pg ; les fonctions
// marquées « transaction requise » attendent un client déjà dans une transaction.
import { randomUUID } from 'node:crypto';

// ------------------------------------------------------------------ validation

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** Retourne { value } si la requête est valide, sinon { errors: string[] }. */
export function validateOrderRequest(body) {
  const errors = [];
  if (!isObject(body)) return { errors: ['body must be an object'] };

  // Forme de l'énoncé : items[] = liste de SKU, quantity = une quantité appliquée à chaque
  // article (décision SV5). Traduite ensuite en lignes { sku, quantity } pour le reste du domaine.
  const { customerId, items, quantity, paymentInformation, shippingAddress } = body;
  if (!isNonEmptyString(customerId)) errors.push('customerId is required');
  if (!Number.isInteger(quantity) || quantity <= 0) errors.push('quantity must be a positive integer');
  if (!isObject(paymentInformation)) errors.push('paymentInformation must be an object');
  if (!isObject(shippingAddress)) errors.push('shippingAddress must be an object');

  if (!Array.isArray(items) || items.length === 0) {
    errors.push('items must be a non-empty array of SKUs');
  } else {
    const seen = new Set();
    items.forEach((sku, i) => {
      if (!isNonEmptyString(sku)) errors.push(`items[${i}] must be a SKU (non-empty string)`);
      else if (seen.has(sku)) errors.push(`items[${i}] is duplicated`);
      else seen.add(sku);
    });
  }

  if (errors.length > 0) return { errors };
  return {
    value: {
      customerId,
      items: items.map((sku) => ({ sku, quantity })),
      paymentInformation,
      shippingAddress,
    },
  };
}

// ------------------------------------------------------------------ prix

/**
 * Lit les prix du catalogue (lecture seule de products, identique dans A et B).
 * Retourne { lines, totalCents } ou { unknownSkus }.
 */
export async function priceItems(db, items) {
  const { rows } = await db.query(
    'SELECT sku, price_cents FROM products WHERE sku = ANY($1::text[])',
    [items.map((i) => i.sku)],
  );
  const prices = new Map(rows.map((r) => [r.sku, r.price_cents]));
  const unknownSkus = items.filter((i) => !prices.has(i.sku)).map((i) => i.sku);
  if (unknownSkus.length > 0) return { unknownSkus };

  const lines = items.map((i) => ({ ...i, unitPriceCents: prices.get(i.sku) }));
  const totalCents = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
  return { lines, totalCents };
}

// ------------------------------------------------------------------ transitions

/**
 * Crée la commande en RECEIVED avec ses lignes. Transaction requise.
 * `receivedAt` = instant d'arrivée de la requête, noté par le transport avant toute attente
 * (pool, lecture des prix) : c'est le départ de toutes les latences (cas C3).
 */
export async function createOrder(client, { receivedAt, customerId, lines, totalCents, paymentInformation, shippingAddress }) {
  if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
    throw new TypeError('createOrder: receivedAt must be a valid Date');
  }
  const orderId = randomUUID();
  await client.query(
    `INSERT INTO orders (id, customer_id, total_cents, payment_info, shipping_address, received_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, customerId, totalCents, paymentInformation, shippingAddress, receivedAt],
  );
  await client.query(
    `INSERT INTO order_items (order_id, sku, quantity, unit_price_cents)
     SELECT $1, * FROM unnest($2::text[], $3::int[], $4::int[])`,
    [orderId, lines.map((l) => l.sku), lines.map((l) => l.quantity), lines.map((l) => l.unitPriceCents)],
  );
  return orderId;
}

/** Paiement autorisé : RECEIVED → ACCEPTED. */
export async function markAccepted(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET status = 'ACCEPTED', payment_status = 'AUTHORIZED', accepted_at = now()
      WHERE id = $1 AND status = 'RECEIVED'`,
    [orderId],
  );
  return rowCount === 1;
}

/** Paiement refusé : RECEIVED → REJECTED. */
export async function rejectForPaymentDeclined(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET status = 'REJECTED', payment_status = 'DECLINED',
            rejection_reason = 'PAYMENT_DECLINED', rejected_at = now()
      WHERE id = $1 AND status = 'RECEIVED'`,
    [orderId],
  );
  return rowCount === 1;
}

/** Stock réservé (copie locale lue par l'invariant). */
export async function markStockReserved(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET stock_status = 'RESERVED' WHERE id = $1 AND stock_status = 'PENDING'`,
    [orderId],
  );
  return rowCount === 1;
}

/**
 * Invariant I1, point unique de confirmation (docs/invariants.md).
 * Retourne true si la commande est passée en CONFIRMED.
 */
export async function confirmOrder(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET status='CONFIRMED', confirmed_at=now()
      WHERE id=$1 AND status='ACCEPTED'
        AND payment_status='AUTHORIZED' AND stock_status='RESERVED'`,
    [orderId],
  );
  return rowCount === 1;
}

/** Stock insuffisant (copie locale), noté avant la décision de rejet (D14). */
export async function markStockInsufficient(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET stock_status = 'INSUFFICIENT' WHERE id = $1 AND stock_status = 'PENDING'`,
    [orderId],
  );
  return rowCount === 1;
}

/**
 * Stock insuffisant après paiement autorisé : ACCEPTED → REJECTED. Le void du paiement suit.
 * Ne rejette que si les deux faits sont notés (paiement autorisé ET stock insuffisant), quel que
 * soit l'ordre dans lequel ils sont arrivés (D14 : « noter le fait, puis décider »).
 */
export async function rejectForInsufficientStock(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET status = 'REJECTED', rejection_reason = 'INSUFFICIENT_STOCK', rejected_at = now()
      WHERE id = $1 AND status = 'ACCEPTED'
        AND payment_status = 'AUTHORIZED' AND stock_status = 'INSUFFICIENT'`,
    [orderId],
  );
  return rowCount === 1;
}

/** Compensation terminée : paiement annulé (copie locale). */
export async function markPaymentVoided(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET payment_status = 'VOIDED' WHERE id = $1 AND payment_status = 'AUTHORIZED'`,
    [orderId],
  );
  return rowCount === 1;
}

/** Expédition demandée et notification envoyée. */
export async function markCompleted(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE orders SET completed_at = now()
      WHERE id = $1 AND status = 'CONFIRMED' AND completed_at IS NULL`,
    [orderId],
  );
  return rowCount === 1;
}

// ------------------------------------------------------------------ lecture

/** Adresse de livraison de la commande (données d'Order), transmise à Shipping. */
export async function getShippingAddress(db, orderId) {
  const { rows } = await db.query('SELECT shipping_address FROM orders WHERE id = $1', [orderId]);
  return rows[0]?.shipping_address ?? null;
}

export async function getOrder(db, orderId) {
  const { rows } = await db.query(
    `SELECT o.id, o.customer_id, o.status, o.payment_status, o.stock_status, o.rejection_reason,
            o.total_cents, o.received_at, o.accepted_at, o.confirmed_at, o.completed_at, o.rejected_at,
            coalesce(json_agg(json_build_object('sku', i.sku, 'quantity', i.quantity,
                     'unitPriceCents', i.unit_price_cents) ORDER BY i.sku)
                     FILTER (WHERE i.sku IS NOT NULL), '[]') AS items
       FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id`,
    [orderId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    orderId: r.id,
    customerId: r.customer_id,
    status: r.status,
    paymentStatus: r.payment_status,
    stockStatus: r.stock_status,
    rejectionReason: r.rejection_reason,
    totalCents: r.total_cents,
    items: r.items,
    receivedAt: r.received_at,
    acceptedAt: r.accepted_at,
    confirmedAt: r.confirmed_at,
    completedAt: r.completed_at,
    rejectedAt: r.rejected_at,
  };
}

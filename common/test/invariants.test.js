// Prouve que chaque règle I1–I11 détecte bien une violation injectée.
// Nécessite le PostgreSQL du POC (docker compose -f sync/docker-compose.yml up -d).
// Chaque cas tourne dans une transaction annulée (ROLLBACK) : aucune trace en base,
// et les données déjà présentes ne sont pas modifiées.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect } from '../scripts/db.js';
import { runChecks, CHECKS } from '../scripts/invariants.js';

let client;
before(async () => {
  try {
    client = await connect();
  } catch (err) {
    throw new Error(`PostgreSQL du POC injoignable (${err.message}) : démarrer sync/docker-compose.yml`);
  }
});
after(() => client?.end());

/** Exécute fn dans une transaction toujours annulée, puis renvoie les résultats des règles. */
async function inRollback(fn) {
  await client.query('BEGIN');
  try {
    const ctx = await fn();
    const report = await runChecks(client);
    return { ...ctx, byId: Object.fromEntries(report.results.map((r) => [r.id, r])) };
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Produit de test isolé (n'existe que dans la transaction). */
async function product(sku, { initial = 100, stock = initial, price = 1000 } = {}) {
  await client.query(
    'INSERT INTO products (sku, price_cents, stock, initial_stock) VALUES ($1, $2, $3, $4)',
    [sku, price, stock, initial],
  );
}

/**
 * Commande confirmée et terminée, cohérente avec toutes les règles :
 * 1 article TEST-A × 1, paiement autorisé, réservation, expédition, notification.
 * `patch` modifie la commande après coup ; `skip` omet des effets de bord.
 */
async function confirmedOrder({ sku = 'TEST-A', patch = null, skip = [] } = {}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO orders (id, customer_id, status, payment_status, stock_status, total_cents,
                         payment_info, shipping_address,
                         received_at, accepted_at, confirmed_at, completed_at)
     VALUES ($1, 'test', 'CONFIRMED', 'AUTHORIZED', 'RESERVED', 1000, '{}', '{}',
             now() - interval '4 s', now() - interval '3 s', now() - interval '2 s', now() - interval '1 s')`,
    [id],
  );
  await client.query('INSERT INTO order_items VALUES ($1, $2, 1, 1000)', [id, sku]);
  if (!skip.includes('payment')) {
    await client.query("INSERT INTO payments (id, order_id, amount_cents, status) VALUES ($1, $2, 1000, 'AUTHORIZED')", [randomUUID(), id]);
  }
  if (!skip.includes('reservation')) {
    await client.query('INSERT INTO stock_reservations (id, order_id, sku, quantity) VALUES ($1, $2, $3, 1)', [randomUUID(), id, sku]);
    await client.query('UPDATE products SET stock = stock - 1 WHERE sku = $1', [sku]);
  }
  if (!skip.includes('shipment')) {
    await client.query("INSERT INTO shipments (id, order_id, address) VALUES ($1, $2, '{}')", [randomUUID(), id]);
  }
  if (!skip.includes('notification')) {
    await client.query("INSERT INTO notifications (id, order_id, kind) VALUES ($1, $2, 'ORDER_CONFIRMED')", [randomUUID(), id]);
  }
  if (patch) await client.query(`UPDATE orders SET ${patch} WHERE id = $1`, [id]);
  return id;
}

/** Commande rejetée (sans effet de bord), selon la raison. */
async function rejectedOrder(reason) {
  const id = randomUUID();
  const pay = reason === 'PAYMENT_DECLINED' ? 'DECLINED' : 'VOIDED';
  const stock = reason === 'PAYMENT_DECLINED' ? 'PENDING' : 'INSUFFICIENT';
  await client.query(
    `INSERT INTO orders (id, customer_id, status, payment_status, stock_status, rejection_reason,
                         total_cents, payment_info, shipping_address, received_at, rejected_at)
     VALUES ($1, 'test', 'REJECTED', $2, $3, $4, 1000, '{}', '{}', now() - interval '1 s', now())`,
    [id, pay, stock, reason],
  );
  await client.query('INSERT INTO order_items VALUES ($1, \'TEST-A\', 1, 1000)', [id]);
  return id;
}

const flagged = (byId, ruleId, key) => byId[ruleId].keys.includes(key);

// ------------------------------------------------------------------ témoin

test('témoin : une commande confirmée cohérente ne viole aucune règle', async () => {
  const { id, byId } = await inRollback(async () => {
    await product('TEST-A');
    return { id: await confirmedOrder() };
  });
  for (const check of CHECKS) {
    assert.ok(!flagged(byId, check.id, id), `${check.id} ne devrait pas signaler la commande témoin`);
  }
  assert.ok(!flagged(byId, 'I6', 'TEST-A'), 'I6 ne devrait pas signaler le produit témoin');
});

test('témoin : des rejets cohérents ne violent aucune règle', async () => {
  const { ids, byId } = await inRollback(async () => {
    await product('TEST-A');
    return { ids: [await rejectedOrder('PAYMENT_DECLINED'), await rejectedOrder('INSUFFICIENT_STOCK')] };
  });
  for (const id of ids) {
    for (const check of CHECKS) assert.ok(!flagged(byId, check.id, id), `${check.id} sur un rejet cohérent`);
  }
});

// ------------------------------------------------------------------ une violation par règle

const cases = [
  ['I1', 'confirmée alors que le stock n\'est pas réservé', async () => {
    await product('TEST-A');
    return confirmedOrder({ patch: "stock_status = 'PENDING'" });
  }],
  ['I2', 'confirmée sans aucun paiement', async () => {
    await product('TEST-A');
    return confirmedOrder({ skip: ['payment'] });
  }],
  ['I3', 'confirmée sans réservation', async () => {
    await product('TEST-A');
    return confirmedOrder({ skip: ['reservation'] });
  }],
  ['I4', 'rejet pour stock insuffisant avec un paiement encore autorisé', async () => {
    await product('TEST-A');
    const id = await rejectedOrder('INSUFFICIENT_STOCK');
    await client.query("INSERT INTO payments (id, order_id, amount_cents, status) VALUES ($1, $2, 1000, 'AUTHORIZED')", [randomUUID(), id]);
    return id;
  }],
  ['I5', 'rejet pour paiement refusé avec une réservation', async () => {
    await product('TEST-A');
    const id = await rejectedOrder('PAYMENT_DECLINED');
    await client.query("INSERT INTO stock_reservations (id, order_id, sku, quantity) VALUES ($1, $2, 'TEST-A', 1)", [randomUUID(), id]);
    return id;
  }],
  ['I6', 'réservation enregistrée sans que le stock baisse', async () => {
    await product('TEST-B', { initial: 10 });
    await client.query("INSERT INTO stock_reservations (id, order_id, sku, quantity) VALUES ($1, $2, 'TEST-B', 3)", [randomUUID(), randomUUID()]);
    return 'TEST-B';
  }],
  ['I7', 'expédition en double', async () => {
    await product('TEST-A');
    const id = await confirmedOrder();
    await client.query("INSERT INTO shipments (id, order_id, address) VALUES ($1, $2, '{}')", [randomUUID(), id]);
    return id;
  }],
  ['I8', 'expédition pour une commande rejetée', async () => {
    await product('TEST-A');
    const id = await rejectedOrder('PAYMENT_DECLINED');
    await client.query("INSERT INTO shipments (id, order_id, address) VALUES ($1, $2, '{}')", [randomUUID(), id]);
    return id;
  }],
  ['I9', 'confirmée avant d\'avoir été acceptée', async () => {
    await product('TEST-A');
    return confirmedOrder({ patch: "confirmed_at = accepted_at - interval '1 s'" });
  }],
  ['I10', 'commande restée ACCEPTED', async () => {
    await product('TEST-A');
    return confirmedOrder({ patch: "status = 'ACCEPTED', confirmed_at = NULL, completed_at = NULL" });
  }],
  ['I11', 'confirmée mais jamais terminée', async () => {
    await product('TEST-A');
    return confirmedOrder({ skip: ['shipment', 'notification'], patch: 'completed_at = NULL' });
  }],
];

for (const [ruleId, label, inject] of cases) {
  test(`${ruleId} détecte : ${label}`, async () => {
    const { key, byId } = await inRollback(async () => ({ key: await inject() }));
    assert.ok(flagged(byId, ruleId, key), `${ruleId} aurait dû signaler ${key}`);
  });
}

test('chaque règle a son cas de violation', () => {
  assert.deepEqual(cases.map(([id]) => id), CHECKS.map((c) => c.id));
});

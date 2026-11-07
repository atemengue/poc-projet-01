import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderRequest } from '../services/order/domain.js';
import { decide, DECLINED_CARD_TOKEN } from '../services/payment/domain.js';

const valid = () => ({
  customerId: 'c-1',
  items: ['SKU-001', 'SKU-003'],
  quantity: 2,
  paymentInformation: { cardToken: 'tok_ok' },
  shippingAddress: { line1: '1 rue X', city: 'Montréal' },
});

test('une requête complète est acceptée et la quantité appliquée à chaque article', () => {
  const { value, errors } = validateOrderRequest(valid());
  assert.equal(errors, undefined);
  assert.deepEqual(value.items, [{ sku: 'SKU-001', quantity: 2 }, { sku: 'SKU-003', quantity: 2 }]);
});

test('les champs manquants sont tous signalés', () => {
  const { errors } = validateOrderRequest({});
  assert.equal(errors.length, 5);
});

test('un corps non objet est refusé', () => {
  for (const body of [null, 'x', [], 42]) assert.ok(validateOrderRequest(body).errors);
});

test('quantité absente, nulle, négative, décimale ou texte refusée', () => {
  for (const quantity of [undefined, 0, -1, 1.5, '2']) {
    const body = { ...valid(), quantity };
    assert.ok(validateOrderRequest(body).errors, `quantity=${quantity}`);
  }
});

test('items doit être une liste non vide de SKU', () => {
  for (const items of [[], 'SKU-001', [''], [42], [{ sku: 'SKU-001', quantity: 1 }]]) {
    const body = { ...valid(), items };
    assert.ok(validateOrderRequest(body).errors, `items=${JSON.stringify(items)}`);
  }
});

test('un SKU en double est refusé', () => {
  const body = { ...valid(), items: ['A', 'A'] };
  assert.match(validateOrderRequest(body).errors[0], /duplicated/);
});

test('les champs inconnus sont ignorés', () => {
  const body = { ...valid(), items: ['SKU-001'], price: 0 };
  const { value } = validateOrderRequest(body);
  assert.deepEqual(Object.keys(value).sort(), ['customerId', 'items', 'paymentInformation', 'shippingAddress']);
  assert.deepEqual(value.items, [{ sku: 'SKU-001', quantity: 2 }]);
});

test('le paiement est refusé uniquement avec le jeton de refus', () => {
  assert.equal(decide({ cardToken: DECLINED_CARD_TOKEN }), 'DECLINED');
  assert.equal(decide({ cardToken: 'tok_ok' }), 'AUTHORIZED');
  assert.equal(decide({}), 'AUTHORIZED');
});

// --- createOrder : received_at = instant d'arrivée fourni par le transport (cas C3)

import { createOrder } from '../services/order/domain.js';

const fakeClient = () => {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
};
const draft = (receivedAt) => ({
  receivedAt,
  customerId: 'c-1',
  lines: [{ sku: 'SKU-001', quantity: 1, unitPriceCents: 1999 }],
  totalCents: 1999,
  paymentInformation: {},
  shippingAddress: {},
});

test("createOrder écrit l'instant d'arrivée dans received_at, pas now()", async () => {
  const client = fakeClient();
  const receivedAt = new Date('2026-11-03T10:00:00.123Z');
  await createOrder(client, draft(receivedAt));
  const insert = client.calls[0];
  assert.match(insert.sql, /received_at/);
  assert.ok(insert.params.includes(receivedAt));
});

test('createOrder refuse une commande sans instant d\'arrivée valide', async () => {
  for (const receivedAt of [undefined, null, '2026-11-03', new Date('invalide')]) {
    const client = fakeClient();
    await assert.rejects(createOrder(client, draft(receivedAt)), TypeError);
    assert.equal(client.calls.length, 0, 'aucun INSERT ne doit partir');
  }
});

// --- D14 : le rejet pour stock insuffisant exige les deux faits notés

import { markStockInsufficient, rejectForInsufficientStock } from '../services/order/domain.js';

test('markStockInsufficient ne touche que stock_status, depuis PENDING', async () => {
  const client = fakeClient();
  await markStockInsufficient(client, 'o-1');
  assert.match(client.calls[0].sql, /SET stock_status = 'INSUFFICIENT'/);
  assert.match(client.calls[0].sql, /stock_status = 'PENDING'/);
  assert.doesNotMatch(client.calls[0].sql, /status = 'REJECTED'/);
});

test('rejectForInsufficientStock exige ACCEPTED, paiement AUTHORIZED et stock INSUFFICIENT', async () => {
  const client = fakeClient();
  await rejectForInsufficientStock(client, 'o-1');
  const { sql } = client.calls[0];
  assert.match(sql, /status = 'ACCEPTED'/);
  assert.match(sql, /payment_status = 'AUTHORIZED'/);
  assert.match(sql, /stock_status = 'INSUFFICIENT'/);
});

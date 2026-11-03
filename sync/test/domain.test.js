import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderRequest } from '../services/order/domain.js';
import { decide, DECLINED_CARD_TOKEN } from '../services/payment/domain.js';

const valid = () => ({
  customerId: 'c-1',
  items: [{ sku: 'SKU-001', quantity: 2 }],
  paymentInformation: { cardToken: 'tok_ok' },
  shippingAddress: { line1: '1 rue X', city: 'Montréal' },
});

test('une requête complète est acceptée', () => {
  const { value, errors } = validateOrderRequest(valid());
  assert.equal(errors, undefined);
  assert.deepEqual(value.items, [{ sku: 'SKU-001', quantity: 2 }]);
});

test('les champs manquants sont tous signalés', () => {
  const { errors } = validateOrderRequest({});
  assert.equal(errors.length, 4);
});

test('un corps non objet est refusé', () => {
  for (const body of [null, 'x', [], 42]) assert.ok(validateOrderRequest(body).errors);
});

test('quantité nulle, négative ou décimale refusée', () => {
  for (const quantity of [0, -1, 1.5, '2']) {
    const body = { ...valid(), items: [{ sku: 'SKU-001', quantity }] };
    assert.ok(validateOrderRequest(body).errors, `quantity=${quantity}`);
  }
});

test('un SKU en double est refusé', () => {
  const body = { ...valid(), items: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }] };
  assert.match(validateOrderRequest(body).errors[0], /duplicated/);
});

test('les champs inconnus des articles sont ignorés', () => {
  const body = { ...valid(), items: [{ sku: 'SKU-001', quantity: 1, price: 0 }] };
  assert.deepEqual(validateOrderRequest(body).value.items, [{ sku: 'SKU-001', quantity: 1 }]);
});

test('le paiement est refusé uniquement avec le jeton de refus', () => {
  assert.equal(decide({ cardToken: DECLINED_CARD_TOKEN }), 'DECLINED');
  assert.equal(decide({ cardToken: 'tok_ok' }), 'AUTHORIZED');
  assert.equal(decide({}), 'AUTHORIZED');
});

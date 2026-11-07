import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processEvent } from '../lib/consumer.js';

// Faux client pg : processed_events renvoie « déjà présent » si l'eventId est dans `seen`.
const fakeClient = (seen = new Set()) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('processed_events')) {
        const key = `${params[0]}:${params[1]}`;
        if (seen.has(key)) return { rowCount: 0, rows: [] };
        seen.add(key);
      }
      return { rowCount: 1, rows: [] };
    },
  };
};
const inTx = (client) => (fn) => fn(client);
const event = { eventId: '11111111-1111-1111-1111-111111111111', type: 'OrderCreated', orderId: 'o-1', payload: {} };

test('un type sans handler est ignoré, sans transaction', async () => {
  const client = fakeClient();
  const r = await processEvent({ consumer: 'payment', handlers: {}, event, transaction: inTx(client) });
  assert.equal(r.status, 'ignored');
  assert.equal(client.calls.length, 0);
});

test("l'effet métier et les événements émis sont dans la même transaction, après processed_events", async () => {
  const client = fakeClient();
  let latencyCalled = false;
  const handlers = {
    OrderCreated: {
      latency: async () => { latencyCalled = true; },
      handle: async (c, e, emit) => {
        await c.query('INSERT INTO payments …', [e.orderId]);
        await emit('PaymentAuthorized', { amountCents: 100 });
      },
    },
  };
  const r = await processEvent({ consumer: 'payment', handlers, event, transaction: inTx(client) });
  assert.equal(r.status, 'processed');
  assert.equal(r.emitted.length, 1);
  assert.ok(latencyCalled);
  assert.match(client.calls[0].sql, /processed_events/);
  assert.match(client.calls[1].sql, /payments/);
  assert.match(client.calls[2].sql, /INSERT INTO outbox/);
  assert.equal(client.calls[2].params[1], 'o-1');          // aggregate_id = orderId de l'événement reçu
  assert.equal(client.calls[2].params[2], 'PaymentAuthorized');
});

test("un événement déjà traité par ce consommateur n'a aucun effet (idempotence)", async () => {
  const seen = new Set();
  let effects = 0;
  const handlers = { OrderCreated: { handle: async () => { effects += 1; } } };
  const first = await processEvent({ consumer: 'payment', handlers, event, transaction: inTx(fakeClient(seen)) });
  const second = await processEvent({ consumer: 'payment', handlers, event, transaction: inTx(fakeClient(seen)) });
  assert.equal(first.status, 'processed');
  assert.equal(second.status, 'duplicate');
  assert.equal(effects, 1);
});

test('le même événement est traité une fois par chaque consommateur', async () => {
  const seen = new Set();
  const handlers = { OrderCreated: { handle: async () => {} } };
  const a = await processEvent({ consumer: 'payment', handlers, event, transaction: inTx(fakeClient(seen)) });
  const b = await processEvent({ consumer: 'notification', handlers, event, transaction: inTx(fakeClient(seen)) });
  assert.equal(a.status, 'processed');
  assert.equal(b.status, 'processed');
});

test("une erreur du handler remonte (le message partira en DLQ) et n'est pas avalée", async () => {
  const handlers = { OrderCreated: { handle: async () => { throw new Error('boom'); } } };
  await assert.rejects(processEvent({ consumer: 'payment', handlers, event, transaction: inTx(fakeClient()) }), /boom/);
});

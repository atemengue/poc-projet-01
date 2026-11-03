import { createServer, start } from '../../lib/server.js';
import { pool, withTransaction } from '../../lib/db.js';
import { UpstreamError } from '../../lib/http-client.js';
import * as domain from './domain.js';
import { processOrder } from './workflow.js';

const app = createServer();

// Réponse après le workflow complet : 201 si la commande atteint un état terminal
// (CONFIRMED ou REJECTED), 502 si une dépendance a échoué avant.
app.post('/orders', async (req, reply) => {
  const { value, errors } = domain.validateOrderRequest(req.body);
  if (errors) return reply.code(400).send({ error: 'INVALID_REQUEST', details: errors });

  const priced = await domain.priceItems(pool, value.items);
  if (priced.unknownSkus) {
    return reply.code(400).send({ error: 'UNKNOWN_SKU', details: priced.unknownSkus });
  }

  const order = { ...value, ...priced };
  const orderId = await withTransaction((client) => domain.createOrder(client, order));
  const log = req.log.child({ orderId });

  try {
    const result = await processOrder({ ...order, orderId }, log);
    log.info({ status: result.status, rejectionReason: result.rejectionReason }, 'order processed');
    return reply.code(201).send({ orderId, ...result });
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    const current = await domain.getOrder(pool, orderId);
    log.error({ err: err.message, status: current.status }, 'order processing failed');
    return reply.code(502).send({ orderId, status: current.status, error: 'UPSTREAM_FAILURE', details: err.message });
  }
});

app.get('/orders/:id', {
  schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
}, async (req, reply) => {
  const order = await domain.getOrder(pool, req.params.id);
  if (!order) return reply.code(404).send({ error: 'NOT_FOUND' });
  return order;
});

await start(app, 3000);

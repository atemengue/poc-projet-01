import { createServer, start, simulatedLatency } from '../../lib/server.js';
import { withTransaction } from '../../lib/db.js';
import * as domain from './domain.js';

const app = createServer();
const latency = simulatedLatency(domain.SIMULATED_LATENCY_MS);

app.post('/reservations', {
  schema: {
    body: {
      type: 'object',
      required: ['orderId', 'items'],
      properties: {
        orderId: { type: 'string', format: 'uuid' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['sku', 'quantity'],
            properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
          },
        },
      },
    },
  },
}, async (req, reply) => {
  const { orderId, items } = req.body;
  await latency();
  const result = await withTransaction((client) => domain.reserveStock(client, orderId, items));
  req.log.debug({ orderId, ...result }, 'reservation processed');
  return reply.code(result.status === 'RESERVED' ? 201 : 200).send(result);
});

await start(app, 3002);

import { createServer, start, simulatedLatency } from '../../lib/server.js';
import { pool } from '../../lib/db.js';
import * as domain from './domain.js';

const app = createServer();
const latency = simulatedLatency(domain.SIMULATED_LATENCY_MS);

app.post('/notifications', {
  schema: {
    body: {
      type: 'object',
      required: ['orderId', 'kind'],
      properties: { orderId: { type: 'string', format: 'uuid' }, kind: { enum: domain.KINDS } },
    },
  },
}, async (req, reply) => {
  const { orderId, kind } = req.body;
  await latency();
  const notificationId = await domain.createNotification(pool, { orderId, kind });
  req.log.debug({ orderId, notificationId, kind }, 'notification sent');
  return reply.code(201).send({ notificationId });
});

await start(app, 3004);

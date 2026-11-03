import { createServer, start, simulatedLatency } from '../../lib/server.js';
import { pool } from '../../lib/db.js';
import * as domain from './domain.js';

const app = createServer();
const latency = simulatedLatency(domain.SIMULATED_LATENCY_MS);

app.post('/shipments', {
  schema: {
    body: {
      type: 'object',
      required: ['orderId', 'address'],
      properties: { orderId: { type: 'string', format: 'uuid' }, address: { type: 'object' } },
    },
  },
}, async (req, reply) => {
  const { orderId, address } = req.body;
  await latency();
  const shipmentId = await domain.createShipment(pool, { orderId, address });
  req.log.debug({ orderId, shipmentId }, 'shipment requested');
  return reply.code(201).send({ shipmentId });
});

await start(app, 3003);

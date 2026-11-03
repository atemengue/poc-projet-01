import { createServer, start, simulatedLatency } from '../../lib/server.js';
import { pool } from '../../lib/db.js';
import * as domain from './domain.js';

const app = createServer();
const latency = simulatedLatency(domain.SIMULATED_LATENCY_MS);

const uuid = { type: 'string', format: 'uuid' };

app.post('/payments', {
  schema: {
    body: {
      type: 'object',
      required: ['orderId', 'amountCents', 'paymentInformation'],
      properties: {
        orderId: uuid,
        amountCents: { type: 'integer', minimum: 0 },
        paymentInformation: { type: 'object' },
      },
    },
  },
}, async (req, reply) => {
  const { orderId, amountCents, paymentInformation } = req.body;
  await latency();
  const status = domain.decide(paymentInformation);
  const paymentId = await domain.recordPayment(pool, { orderId, amountCents, status });
  req.log.debug({ orderId, paymentId, status }, 'payment processed');
  return reply.code(201).send({ paymentId, status });
});

app.post('/payments/void', {
  schema: {
    body: { type: 'object', required: ['orderId'], properties: { orderId: uuid } },
  },
}, async (req) => {
  const { orderId } = req.body;
  await latency();
  const voided = await domain.voidPaymentsForOrder(pool, orderId);
  req.log.debug({ orderId, voided }, 'payments voided');
  return { voided };
});

await start(app, 3001);

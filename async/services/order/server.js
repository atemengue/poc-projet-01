// Order (async/) : reçoit les commandes en HTTP, publie OrderCreated, puis suit la commande en
// réagissant aux événements des autres services (handlers.js).
import { pool, withTransaction } from '../../lib/db.js';
import { addEvent, publishEvents } from '../../lib/outbox.js';
import { runService } from '../../lib/service.js';
import * as domain from './domain.js';
import { handlers } from './handlers.js';

// Instant d'arrivée, noté au tout premier point d'entrée (cas C3, SV13) : départ des latences.
const markReceived = (req, _reply, done) => {
  req.receivedAt = new Date();
  done();
};

function routes(app, broker) {
  // D4 : 202 dès que la commande et OrderCreated sont enregistrés (même transaction). La suite
  // se lit par GET /orders/:id ; « acceptée » se mesure par horodatage (accepted_at).
  app.post('/orders', { onRequest: markReceived }, async (req, reply) => {
    const { receivedAt } = req;
    const { value, errors } = domain.validateOrderRequest(req.body);
    if (errors) return reply.code(400).send({ error: 'INVALID_REQUEST', details: errors });

    const priced = await domain.priceItems(pool, value.items);
    if (priced.unknownSkus) {
      return reply.code(400).send({ error: 'UNKNOWN_SKU', details: priced.unknownSkus });
    }

    const order = { ...value, ...priced, receivedAt };
    const { orderId, eventId } = await withTransaction(async (client) => {
      const id = await domain.createOrder(client, order);
      const evt = await addEvent(client, {
        type: 'OrderCreated',
        orderId: id,
        payload: {
          items: order.lines.map(({ sku, quantity }) => ({ sku, quantity })),
          totalCents: order.totalCents,
          paymentInformation: order.paymentInformation,
        },
      });
      return { orderId: id, eventId: evt };
    });

    reply.code(202).send({ orderId, status: 'RECEIVED' });

    // Publication après la réponse : la commande est déjà durable (outbox) ; un échec ici est
    // rattrapé par le balayage de secours.
    publishEvents(broker, [eventId])
      .catch((err) => req.log.warn({ orderId, err: err.message }, 'post-commit publish failed, left to the sweeper'));
    return reply;
  });

  app.get('/orders/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    const found = await domain.getOrder(pool, req.params.id);
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND' });
    return found;
  });
}

await runService({ name: 'order', port: 3000, handlers, routes });

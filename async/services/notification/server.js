// Notification (async/) : confirmation au client après la demande d'expédition (même ordre que
// sync/), avis de rejet sur OrderRejected. Logique métier : domain.js, identique à sync/.
import { simulatedLatency } from '../../lib/server.js';
import { runService } from '../../lib/service.js';
import * as domain from './domain.js';

const latency = simulatedLatency(domain.SIMULATED_LATENCY_MS);

const notify = (kind) => ({
  latency,
  async handle(client, event, emit) {
    const notificationId = await domain.createNotification(client, { orderId: event.orderId, kind });
    await emit('NotificationSent', { kind, notificationId });
  },
});

await runService({
  name: 'notification',
  port: 3004,
  handlers: {
    ShipmentRequested: notify('ORDER_CONFIRMED'),
    OrderRejected: notify('ORDER_REJECTED'),
  },
});

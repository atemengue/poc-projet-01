// Shipping (async/) : réagit à OrderConfirmed (D5 : l'expédition suit la confirmation).
// Logique métier : domain.js, identique à sync/.
import { simulatedLatency } from '../../lib/server.js';
import { runService } from '../../lib/service.js';
import * as domain from './domain.js';

const latency = simulatedLatency(domain.SIMULATED_LATENCY_MS);

await runService({
  name: 'shipping',
  port: 3003,
  handlers: {
    OrderConfirmed: {
      latency,
      async handle(client, event, emit) {
        const shipmentId = await domain.createShipment(client, {
          orderId: event.orderId,
          address: event.payload.shippingAddress,
        });
        await emit('ShipmentRequested', { shipmentId });
      },
    },
  },
});

// Inventory (async/) : réagit à PaymentAuthorized (réservation tout ou rien).
// Logique métier : domain.js, identique à sync/.
import { simulatedLatency } from '../../lib/server.js';
import { runService } from '../../lib/service.js';
import * as domain from './domain.js';

const latency = simulatedLatency(domain.SIMULATED_LATENCY_MS);

await runService({
  name: 'inventory',
  port: 3002,
  handlers: {
    PaymentAuthorized: {
      latency,
      async handle(client, event, emit) {
        const result = await domain.reserveStock(client, event.orderId, event.payload.items);
        if (result.status === 'RESERVED') await emit('InventoryReserved', {});
        else await emit('InventoryInsufficient', { sku: result.sku });
      },
    },
  },
});

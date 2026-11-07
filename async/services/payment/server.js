// Payment (async/) : réagit à OrderCreated (autorisation) et à OrderRejected pour stock
// insuffisant (compensation : annulation). Logique métier : domain.js, identique à sync/.
import { simulatedLatency } from '../../lib/server.js';
import { runService } from '../../lib/service.js';
import * as domain from './domain.js';

const latency = simulatedLatency(domain.SIMULATED_LATENCY_MS);
const isCompensation = (event) => event.payload.reason === 'INSUFFICIENT_STOCK';

await runService({
  name: 'payment',
  port: 3001,
  handlers: {
    OrderCreated: {
      latency,
      async handle(client, event, emit) {
        const { totalCents, paymentInformation, items } = event.payload;
        const status = domain.decide(paymentInformation);
        await domain.recordPayment(client, { orderId: event.orderId, amountCents: totalCents, status });
        // Inventory a besoin des articles : ils voyagent dans l'événement (AS2).
        if (status === 'AUTHORIZED') await emit('PaymentAuthorized', { amountCents: totalCents, items });
        else await emit('PaymentDeclined', { amountCents: totalCents });
      },
    },
    OrderRejected: {
      latency: async (event) => (isCompensation(event) ? latency() : undefined),
      async handle(client, event, emit) {
        if (!isCompensation(event)) return; // paiement refusé : rien à annuler
        const voided = await domain.voidPaymentsForOrder(client, event.orderId);
        await emit('PaymentVoided', { voided });
      },
    },
  },
});

// Réactions d'Order aux événements (async/). Logique métier : domain.js, identique à sync/.
//
// D14 « noter le fait, puis décider » : chaque événement enregistre son fait dans orders, puis
// Order tente la décision. Les deux faits (paiement, stock) peuvent arriver dans n'importe quel
// ordre ; les UPDATE portent sur la même ligne, donc les deux transactions s'exécutent l'une
// après l'autre et la seconde voit le fait de la première : c'est elle qui décide, une seule fois.
import * as domain from './domain.js';

/** Confirme (invariant I1) ou rejette pour stock insuffisant, si les faits le permettent. */
export async function decide(client, orderId, emit) {
  if (await domain.confirmOrder(client, orderId)) {
    // D5 : la confirmation précède l'expédition ; Shipping reçoit l'adresse dans l'événement.
    const shippingAddress = await domain.getShippingAddress(client, orderId);
    await emit('OrderConfirmed', { shippingAddress });
    return 'CONFIRMED';
  }
  if (await domain.rejectForInsufficientStock(client, orderId)) {
    await emit('OrderRejected', { reason: 'INSUFFICIENT_STOCK' }); // déclenche le void (AS3)
    return 'REJECTED';
  }
  return null; // il manque encore un fait
}

export const handlers = {
  PaymentAuthorized: {
    async handle(client, event, emit) {
      await domain.markAccepted(client, event.orderId);
      await decide(client, event.orderId, emit);
    },
  },
  PaymentDeclined: {
    async handle(client, event, emit) {
      if (await domain.rejectForPaymentDeclined(client, event.orderId)) {
        await emit('OrderRejected', { reason: 'PAYMENT_DECLINED' });
      }
    },
  },
  InventoryReserved: {
    async handle(client, event, emit) {
      await domain.markStockReserved(client, event.orderId);
      await decide(client, event.orderId, emit);
    },
  },
  InventoryInsufficient: {
    async handle(client, event, emit) {
      await domain.markStockInsufficient(client, event.orderId);
      await decide(client, event.orderId, emit);
    },
  },
  PaymentVoided: {
    async handle(client, event) {
      await domain.markPaymentVoided(client, event.orderId);
    },
  },
  // Fin du traitement : la notification de confirmation est envoyée (même point que sync/).
  NotificationSent: {
    async handle(client, event) {
      if (event.payload.kind === 'ORDER_CONFIRMED') await domain.markCompleted(client, event.orderId);
    },
  },
};

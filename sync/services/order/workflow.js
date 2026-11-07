// Enchaînement synchrone (propre à sync/) : Payment → Inventory → Shipping → Notification.
// Aucune nouvelle tentative et aucun mécanisme de résilience (règle d'équité, CLAUDE.md §6).
import { pool } from '../../lib/db.js';
import { postJson, UpstreamError } from '../../lib/http-client.js';
import * as domain from './domain.js';

const PAYMENT_URL = process.env.PAYMENT_URL ?? 'http://payment:3001';
const INVENTORY_URL = process.env.INVENTORY_URL ?? 'http://inventory:3002';
const SHIPPING_URL = process.env.SHIPPING_URL ?? 'http://shipping:3003';
const NOTIFICATION_URL = process.env.NOTIFICATION_URL ?? 'http://notification:3004';

/**
 * Traite une commande déjà enregistrée en RECEIVED, jusqu'à un état terminal.
 * Retourne { status, rejectionReason?, completed }.
 * Lève UpstreamError si une dépendance échoue avant l'état terminal : la commande
 * reste alors dans l'état atteint (RECEIVED ou ACCEPTED), visible par I10.
 */
export async function processOrder(order, log) {
  const { orderId, lines, totalCents, paymentInformation, shippingAddress } = order;

  // 1. Paiement
  const payment = await postJson(`${PAYMENT_URL}/payments`, {
    orderId, amountCents: totalCents, paymentInformation,
  });
  if (payment.status === 'DECLINED') {
    await domain.rejectForPaymentDeclined(pool, orderId);
    await notifyAfterTerminal(orderId, 'ORDER_REJECTED', log);
    return { status: 'REJECTED', rejectionReason: 'PAYMENT_DECLINED', completed: false };
  }
  await domain.markAccepted(pool, orderId);

  // 2. Stock
  const reservation = await postJson(`${INVENTORY_URL}/reservations`, {
    orderId, items: lines.map(({ sku, quantity }) => ({ sku, quantity })),
  });
  if (reservation.status === 'INSUFFICIENT') {
    // Compensation : la commande est rejetée, puis le paiement autorisé est annulé.
    // Si l'annulation échoue, UpstreamError remonte et I4 le signalera.
    await domain.markStockInsufficient(pool, orderId);
    await domain.rejectForInsufficientStock(pool, orderId);
    await postJson(`${PAYMENT_URL}/payments/void`, { orderId });
    await domain.markPaymentVoided(pool, orderId);
    await notifyAfterTerminal(orderId, 'ORDER_REJECTED', log);
    return { status: 'REJECTED', rejectionReason: 'INSUFFICIENT_STOCK', completed: false };
  }
  await domain.markStockReserved(pool, orderId);

  // 3. Confirmation (invariant I1, D5 : dès que le stock est réservé)
  if (!(await domain.confirmOrder(pool, orderId))) {
    log.error({ orderId }, 'invariant refused confirmation');
    const current = await domain.getOrder(pool, orderId);
    return { status: current.status, completed: false };
  }

  // 4. Expédition et notification, après la confirmation
  try {
    await postJson(`${SHIPPING_URL}/shipments`, { orderId, address: shippingAddress });
    await postJson(`${NOTIFICATION_URL}/notifications`, { orderId, kind: 'ORDER_CONFIRMED' });
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    log.warn({ orderId, err: err.message }, 'order confirmed but not completed');
    return { status: 'CONFIRMED', completed: false };
  }
  await domain.markCompleted(pool, orderId);
  return { status: 'CONFIRMED', completed: true };
}

// La commande est déjà dans un état terminal : un échec de notification ne le change pas.
async function notifyAfterTerminal(orderId, kind, log) {
  try {
    await postJson(`${NOTIFICATION_URL}/notifications`, { orderId, kind });
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    log.warn({ orderId, kind, err: err.message }, 'notification failed');
  }
}

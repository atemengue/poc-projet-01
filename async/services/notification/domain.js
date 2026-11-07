// Domaine Notification. Copie identique dans sync/ et async/ (règle de parité).
import { randomUUID } from 'node:crypto';

/** Latence simulée par défaut (surcharge : SIMULATED_LATENCY_MS). */
export const SIMULATED_LATENCY_MS = 10;

export const KINDS = ['ORDER_CONFIRMED', 'ORDER_REJECTED'];

/** Pas d'unicité par commande : un doublon reste visible (DB6, I7). */
export async function createNotification(db, { orderId, kind }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown notification kind: ${kind}`);
  const notificationId = randomUUID();
  await db.query(
    'INSERT INTO notifications (id, order_id, kind) VALUES ($1, $2, $3)',
    [notificationId, orderId, kind],
  );
  return notificationId;
}

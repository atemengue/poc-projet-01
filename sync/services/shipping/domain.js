// Domaine Shipping. Copie identique dans sync/ et async/ (règle de parité).
import { randomUUID } from 'node:crypto';

/** Latence simulée par défaut (surcharge : SIMULATED_LATENCY_MS). */
export const SIMULATED_LATENCY_MS = 20;

/** Pas d'unicité par commande : un doublon reste visible (DB6, I7). */
export async function createShipment(db, { orderId, address }) {
  const shipmentId = randomUUID();
  await db.query(
    'INSERT INTO shipments (id, order_id, address) VALUES ($1, $2, $3)',
    [shipmentId, orderId, address],
  );
  return shipmentId;
}

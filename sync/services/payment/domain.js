// Domaine Payment (simulateur). Copie identique dans sync/ et async/ (règle de parité).
import { randomUUID } from 'node:crypto';

/** Latence simulée par défaut d'un appel au prestataire de paiement (surcharge : SIMULATED_LATENCY_MS). */
export const SIMULATED_LATENCY_MS = 50;

/** Jeton de carte qui provoque un refus. k6 maîtrise ainsi le taux de refus (D12). */
export const DECLINED_CARD_TOKEN = 'tok_declined';

export function decide(paymentInformation) {
  return paymentInformation?.cardToken === DECLINED_CARD_TOKEN ? 'DECLINED' : 'AUTHORIZED';
}

/** Enregistre le résultat. Pas d'unicité par commande : un doublon reste visible (DB6, I7). */
export async function recordPayment(db, { orderId, amountCents, status }) {
  const paymentId = randomUUID();
  await db.query(
    'INSERT INTO payments (id, order_id, amount_cents, status) VALUES ($1, $2, $3, $4)',
    [paymentId, orderId, amountCents, status],
  );
  return paymentId;
}

/** Compensation : annule tous les paiements autorisés de la commande. Retourne le nombre annulé. */
export async function voidPaymentsForOrder(db, orderId) {
  const { rowCount } = await db.query(
    `UPDATE payments SET status = 'VOIDED', voided_at = now()
      WHERE order_id = $1 AND status = 'AUTHORIZED'`,
    [orderId],
  );
  return rowCount;
}

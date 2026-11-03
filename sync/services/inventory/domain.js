// Domaine Inventory. Copie identique dans sync/ et async/ (règle de parité).

/** Latence simulée par défaut (surcharge : SIMULATED_LATENCY_MS). */
export const SIMULATED_LATENCY_MS = 10;

/**
 * Réserve tous les articles ou aucun. Transaction requise (utilise un SAVEPOINT pour
 * annuler une réservation partielle sans annuler le reste de la transaction appelante).
 * Retourne { status: 'RESERVED' } ou { status: 'INSUFFICIENT', sku }.
 */
export async function reserveStock(client, orderId, items) {
  // Ordre fixe des verrous de ligne pour éviter les interblocages entre commandes concurrentes.
  const sorted = [...items].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

  await client.query('SAVEPOINT reserve_stock');
  for (const { sku, quantity } of sorted) {
    const { rowCount } = await client.query(
      'UPDATE products SET stock = stock - $2 WHERE sku = $1 AND stock >= $2',
      [sku, quantity],
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK TO SAVEPOINT reserve_stock');
      return { status: 'INSUFFICIENT', sku };
    }
  }
  await client.query(
    `INSERT INTO stock_reservations (id, order_id, sku, quantity)
     SELECT gen_random_uuid(), $1, * FROM unnest($2::text[], $3::int[])`,
    [orderId, sorted.map((i) => i.sku), sorted.map((i) => i.quantity)],
  );
  await client.query('RELEASE SAVEPOINT reserve_stock');
  return { status: 'RESERVED' };
}

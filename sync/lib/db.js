import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 20),
});

// Exécute fn(client) dans une transaction. Les fonctions de domain.js reçoivent ce
// client et ne font jamais BEGIN/COMMIT elles-mêmes : async/ y ajoutera
// processed_events et outbox dans la même transaction.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

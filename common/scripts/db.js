import pg from 'pg';

// Depuis la machine hôte, PostgreSQL du POC est exposé sur 55432 (DB11).
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://poc:poc@localhost:55432/poc';

export async function connect(url = DATABASE_URL) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Message lisible : certaines erreurs réseau de pg (AggregateError) n'ont qu'un code. */
export function describeError(err) {
  return err.message || err.code || err.errors?.map((e) => e.code ?? e.message).join(', ') || String(err);
}

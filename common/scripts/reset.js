// Remet la base du POC dans son état de départ, avant chaque run (protocole, CLAUDE.md §8).
// Vide toutes les tables de données et rejoue seed.sql (stock remis à sa valeur initiale).
// Réexécutable. Ne touche jamais results/. La purge des files RabbitMQ (async/) viendra à l'étape 4.
//
//   node common/scripts/reset.js            (ou : cd common && npm run reset)
//   DATABASE_URL=postgres://... node common/scripts/reset.js
import { readFile } from 'node:fs/promises';
import { connect, describeError, DATABASE_URL } from './db.js';

const DATA_TABLES = [
  'orders', 'order_items', 'payments', 'stock_reservations', 'shipments',
  'notifications', 'idempotency_keys', 'processed_events', 'outbox',
];

export async function reset(client) {
  // Garde-fou : on ne vide que la base du POC (ou une base de test nommée poc_*).
  const { rows: [{ db }] } = await client.query('SELECT current_database() AS db');
  if (db !== 'poc' && !db.startsWith('poc_')) {
    throw new Error(`refus : la base « ${db} » n'est pas une base du POC (poc ou poc_*)`);
  }
  const seed = await readFile(new URL('../db/seed.sql', import.meta.url), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(`TRUNCATE ${DATA_TABLES.join(', ')}`);
    await client.query(seed);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  const { rows } = await client.query('SELECT sku, stock FROM products ORDER BY sku');
  return { database: db, products: rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let client;
  try {
    client = await connect();
    const { database, products } = await reset(client);
    console.log(`base « ${database} » remise à zéro (${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')})`);
    console.log(`tables vidées : ${DATA_TABLES.join(', ')}`);
    console.log(`stock : ${products.map((p) => `${p.sku}=${p.stock}`).join(', ')}`);
  } catch (err) {
    console.error(`reset impossible : ${describeError(err)}`);
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => {});
  }
}

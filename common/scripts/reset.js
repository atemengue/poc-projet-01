// Remet le POC dans son état de départ, avant chaque run (protocole, CLAUDE.md §8).
// Vide toutes les tables de données et rejoue seed.sql (stock remis à sa valeur initiale), puis,
// si RabbitMQ répond (projet async/), vide toutes ses files, DLQ comprises.
// Réexécutable. Ne touche jamais results/. À lancer sans charge en cours.
//
//   node common/scripts/reset.js            (ou : cd common && npm run reset)
//   DATABASE_URL=postgres://... RABBITMQ_API=http://poc:poc@localhost:15672 node common/scripts/reset.js
import { readFile } from 'node:fs/promises';
import { connect, describeError, DATABASE_URL } from './db.js';

const DATA_TABLES = [
  'orders', 'order_items', 'payments', 'stock_reservations', 'shipments',
  'notifications', 'idempotency_keys', 'processed_events', 'outbox',
];

// API d'administration de RabbitMQ (async/). Absente quand sync/ tourne : la purge est sautée.
const RABBITMQ_API = process.env.RABBITMQ_API ?? 'http://poc:poc@localhost:15672';

/** Vide toutes les files du vhost « / ». Retourne null si RabbitMQ ne répond pas. */
export async function purgeQueues(apiUrl = RABBITMQ_API) {
  const url = new URL(apiUrl);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
  const base = `${url.protocol}//${url.host}/api`;
  let res;
  try {
    res = await fetch(`${base}/queues/%2F`, { headers: { authorization: auth }, signal: AbortSignal.timeout(3000) });
  } catch {
    return null;
  }
  if (!res.ok) throw new Error(`RabbitMQ : liste des files impossible (HTTP ${res.status})`);
  const queues = await res.json();
  const purged = [];
  for (const q of queues) {
    const del = await fetch(`${base}/queues/%2F/${encodeURIComponent(q.name)}/contents`, {
      method: 'DELETE', headers: { authorization: auth },
    });
    if (!del.ok) throw new Error(`RabbitMQ : purge de ${q.name} impossible (HTTP ${del.status})`);
    purged.push({ name: q.name, messages: q.messages ?? 0 });
  }
  return purged;
}

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
    // Files d'abord : un message restant ne doit pas recréer de lignes après le vidage de la base.
    const purged = await purgeQueues();
    client = await connect();
    const { database, products } = await reset(client);
    console.log(`base « ${database} » remise à zéro (${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')})`);
    console.log(`tables vidées : ${DATA_TABLES.join(', ')}`);
    console.log(`stock : ${products.map((p) => `${p.sku}=${p.stock}`).join(', ')}`);
    if (purged === null) console.log('RabbitMQ : absent (projet sync/), aucune file à purger');
    else console.log(`RabbitMQ : ${purged.length} file(s) purgée(s) (${purged.reduce((n, q) => n + q.messages, 0)} message(s) supprimé(s))`);
  } catch (err) {
    console.error(`reset impossible : ${describeError(err)}`);
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => {});
  }
}

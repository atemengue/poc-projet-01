// Outbox transactionnel (D3) avec publication juste après le commit et balayage de secours (AS7),
// et propagation de la trace à travers l'outbox (AS9).
//
// 1. addEvent(client, …) : écrit l'événement dans outbox, dans la transaction de l'effet métier,
//    avec le traceparent courant dans outbox.headers.
// 2. publishEvents(broker, ids) : après le commit, publie ces événements et note published_at.
// 3. startSweeper(broker) : toutes les secondes, publie les lignes restées non publiées
//    (plantage entre le commit et la publication, échec de publication).
//
// Les étapes 2 et 3 verrouillent les lignes (FOR UPDATE SKIP LOCKED) pendant la publication :
// une même ligne n'est jamais publiée deux fois par elles.
import { randomUUID } from 'node:crypto';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { withTransaction } from './db.js';
import { logger } from './logger.js';

const SWEEP_INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS ?? 1000);
const SWEEP_MIN_AGE_MS = Number(process.env.OUTBOX_SWEEP_MIN_AGE_MS ?? 1000);
const SWEEP_BATCH = 500;

/** Écrit un événement dans l'outbox (transaction requise). Retourne son eventId. */
export async function addEvent(client, { type, orderId, payload }) {
  const eventId = randomUUID();
  const headers = {};
  propagation.inject(context.active(), headers); // traceparent de l'étape en cours
  await client.query(
    `INSERT INTO outbox (id, aggregate_id, type, payload, headers, created_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [eventId, orderId, type, payload, headers],
  );
  return eventId;
}

/** Enveloppe d'événement (AS11) reconstruite depuis une ligne d'outbox. */
export function toEnvelope(row) {
  return {
    eventId: row.id,
    type: row.type,
    orderId: row.aggregate_id,
    occurredAt: new Date(row.created_at).toISOString(),
    payload: row.payload,
  };
}

// Publie dans le contexte de trace enregistré à l'écriture : l'instrumentation amqplib crée le
// span de publication comme enfant de ce contexte et en injecte le traceparent dans le message.
function publishRow(broker, row) {
  const parent = propagation.extract(ROOT_CONTEXT, row.headers ?? {});
  return context.with(parent, () => broker.publish(toEnvelope(row), { ...row.headers }));
}

async function publishLocked(broker, selectSql, params) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(selectSql, params);
    for (const row of rows) await publishRow(broker, row);
    if (rows.length > 0) {
      await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
    }
    return rows.length;
  });
}

const COLUMNS = 'id, aggregate_id, type, payload, headers, created_at';

/** Publication juste après le commit des événements que l'on vient d'écrire. */
export async function publishEvents(broker, eventIds) {
  if (!eventIds || eventIds.length === 0) return 0;
  return publishLocked(
    broker,
    `SELECT ${COLUMNS} FROM outbox
      WHERE id = ANY($1::uuid[]) AND published_at IS NULL
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED`,
    [eventIds],
  );
}

/** Balayage de secours : publie les lignes non publiées depuis plus de SWEEP_MIN_AGE_MS. */
export function startSweeper(broker) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await context.with(ROOT_CONTEXT, () => publishLocked(
        broker,
        `SELECT ${COLUMNS} FROM outbox
          WHERE published_at IS NULL AND created_at < now() - make_interval(secs => $1)
          ORDER BY created_at
          LIMIT ${SWEEP_BATCH}
          FOR UPDATE SKIP LOCKED`,
        [SWEEP_MIN_AGE_MS / 1000],
      ));
      if (n > 0) logger.warn({ published: n }, 'outbox sweeper published pending events');
    } catch (err) {
      logger.error({ err: err.message }, 'outbox sweep failed');
    } finally {
      running = false;
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// Consommateur d'événements commun aux services de async/.
//
// Pour chaque message, dans cet ordre :
//   1. latence simulée de l'étape (avant la transaction, comme dans sync/) ;
//   2. une transaction : processed_events (idempotence) + effet métier via domain.js
//      + écriture des événements suivants dans l'outbox ;
//   3. acquittement du message, après le commit ;
//   4. publication des événements écrits (outbox, AS7).
// Un événement déjà traité par ce consommateur est acquitté sans effet.
// Une erreur de traitement envoie le message en DLQ sans nouvelle tentative (budget 0, AS5).
import { withTransaction } from './db.js';
import { logger } from './logger.js';
import { trace } from '@opentelemetry/api';
import { addEvent, publishEvents } from './outbox.js';
import { duplicatesDetected } from './metrics.js';

// K3 (S5, H4) : IDEMPOTENCY=off désactive la protection (témoin) : un événement reçu deux fois
// est traité deux fois.
const IDEMPOTENCY = (process.env.IDEMPOTENCY ?? 'on') !== 'off';

/** Enregistre l'événement comme traité. false si ce consommateur l'a déjà traité (doublon). */
export async function markProcessed(client, consumer, eventId) {
  const { rowCount } = await client.query(
    `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
     ON CONFLICT (consumer, event_id) DO NOTHING`,
    [consumer, eventId],
  );
  return rowCount === 1;
}

/**
 * Traite un événement (hors broker, pour pouvoir le tester).
 * handlers : { [type]: { latency?: (event) => Promise, handle: (client, event, emit) => Promise } }
 * emit(type, payload) écrit un événement de la même commande dans l'outbox.
 * Retourne { status: 'ignored' | 'duplicate' | 'processed', emitted: eventId[] }.
 */
export async function processEvent({ consumer, handlers, event, transaction = withTransaction, idempotency = IDEMPOTENCY }) {
  const handler = handlers[event.type];
  if (!handler) return { status: 'ignored', emitted: [] };

  await handler.latency?.(event);
  return transaction(async (client) => {
    if (idempotency && !(await markProcessed(client, consumer, event.eventId))) {
      return { status: 'duplicate', emitted: [] };
    }
    const emitted = [];
    const emit = async (type, payload) => {
      emitted.push(await addEvent(client, { type, orderId: event.orderId, payload }));
    };
    await handler.handle(client, event, emit);
    return { status: 'processed', emitted };
  });
}

/** Branche le consommateur sur sa file. */
export async function startConsumer(broker, { queue, consumer, handlers }) {
  await broker.consume(queue, async (message) => {
    if (!message) return; // consommateur annulé par le broker

    let event;
    try {
      event = JSON.parse(message.content.toString());
    } catch {
      logger.error({ queue }, 'unreadable message sent to DLQ');
      broker.reject(message);
      return;
    }
    const log = logger.child({ orderId: event.orderId, eventId: event.eventId, type: event.type });
    // Span de traitement (créé par l'instrumentation amqplib) : commande et type d'événement,
    // pour retrouver la trace d'une commande (Tags order.id=<uuid>) et lire la chaîne.
    trace.getActiveSpan()?.setAttributes({ 'order.id': event.orderId, 'event.type': event.type });

    let result;
    try {
      result = await processEvent({ consumer, handlers, event });
    } catch (err) {
      log.error({ err: err.message }, 'event processing failed, sent to DLQ');
      broker.reject(message);
      return;
    }

    broker.ack(message);
    if (result.status === 'duplicate') {
      duplicatesDetected.inc();
      log.info('duplicate event ignored');
    }
    if (result.status === 'ignored') log.warn('no handler for event type');

    // Un échec ici n'est pas une perte : le balayage de secours republiera ces lignes.
    await publishEvents(broker, result.emitted)
      .catch((err) => log.warn({ err: err.message }, 'post-commit publish failed, left to the sweeper'));
  });
}

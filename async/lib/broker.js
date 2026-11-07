// Connexion RabbitMQ (AS8). La topologie (échange orders, files, DLQ) est déclarée par le broker
// lui-même au démarrage (async/rabbitmq/definitions.json) : les services ne la créent pas, ils
// publient et consomment. Une seule source de vérité, et aucun message publié avant que les files
// existent.
import amqp from 'amqplib';
import { logger } from './logger.js';

export const EXCHANGE = 'orders';

// Concurrence maximale par consommateur, égale à OUTBOUND_CONNECTIONS de sync/ (AS6).
const PREFETCH = Number(process.env.PREFETCH ?? 64);

/**
 * Ouvre la connexion et deux canaux : un canal de publication avec confirmations du broker
 * (l'outbox ne marque un événement publié qu'après confirmation), un canal de consommation
 * avec prefetch borné et acquittement manuel.
 */
export async function connectBroker(url = process.env.AMQP_URL) {
  const connection = await amqp.connect(url);
  let closing = false;

  // Une perte de connexion inattendue arrête le service : pas de reconnexion automatique
  // (aucun mécanisme de résilience propre à une variante, CLAUDE.md §6).
  connection.on('error', (err) => logger.error({ err: err.message }, 'broker connection error'));
  connection.on('close', () => {
    if (closing) return;
    logger.fatal('broker connection closed unexpectedly');
    process.exit(1);
  });

  const publishChannel = await connection.createConfirmChannel();
  const consumeChannel = await connection.createChannel();
  await consumeChannel.prefetch(PREFETCH);

  return {
    /** Publie une enveloppe d'événement ; résout quand le broker a confirmé la réception. */
    publish(envelope, headers = {}) {
      return new Promise((resolve, reject) => {
        publishChannel.publish(
          EXCHANGE,
          envelope.type,
          Buffer.from(JSON.stringify(envelope)),
          {
            persistent: true,
            contentType: 'application/json',
            messageId: envelope.eventId,
            type: envelope.type,
            timestamp: Date.parse(envelope.occurredAt),
            headers,
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    },

    consume(queue, onMessage) {
      return consumeChannel.consume(queue, onMessage, { noAck: false });
    },

    ack(message) {
      consumeChannel.ack(message);
    },

    /** Budget de nouvelles tentatives 0 (AS5) : jamais remis en file, part directement en DLQ. */
    reject(message) {
      consumeChannel.nack(message, false, false);
    },

    async close() {
      closing = true;
      await connection.close().catch(() => {});
    },
  };
}

// Démarrage commun d'un service de async/ : serveur HTTP (/health, /metrics, routes propres au
// service), connexion au broker, consommateur de la file du service, balayage de secours de l'outbox.
import { connectBroker } from './broker.js';
import { startConsumer } from './consumer.js';
import { startSweeper } from './outbox.js';
import { createServer, start } from './server.js';

/**
 * name     : nom du consommateur (processed_events.consumer) et de sa file RabbitMQ
 * port     : port HTTP par défaut
 * handlers : { [type d'événement]: { latency?, handle } } (voir lib/consumer.js)
 * routes   : (app, broker) => void, pour ajouter des routes HTTP (Order seulement)
 */
export async function runService({ name, port, handlers, routes }) {
  const broker = await connectBroker();
  const app = createServer();
  routes?.(app, broker);

  await startConsumer(broker, { queue: name, consumer: name, handlers });
  const stopSweeper = startSweeper(broker);

  await start(app, port, async () => {
    stopSweeper();
    await broker.close();
  });
}

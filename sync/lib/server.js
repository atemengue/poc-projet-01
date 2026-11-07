import { setTimeout as sleep } from 'node:timers/promises';
import Fastify from 'fastify';
import { trace } from '@opentelemetry/api';
import { logger } from './logger.js';
import { register } from './metrics.js';
import { pool } from './db.js';

/** Retourne une fonction qui attend la latence simulée du service (défaut du domain.js, surcharge par env). */
export function simulatedLatency(defaultMs) {
  const ms = Number(process.env.SIMULATED_LATENCY_MS ?? defaultMs);
  return () => (ms > 0 ? sleep(ms) : Promise.resolve());
}

/** Pose order.id sur le span actif (requête HTTP ou traitement d'événement). */
export function tagOrder(orderId) {
  trace.getActiveSpan()?.setAttribute('order.id', orderId);
}

export function createServer() {
  // Pas de log par requête : à 500 cmd/s il coûterait du CPU et brouillerait la mesure.
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true });

  // Traces (étape 6) : le span HTTP créé par l'instrumentation s'appelait « POST » ; il prend
  // le nom de la route (« POST /orders ») et l'attribut http.route. L'attribut order.id permet
  // de retrouver la trace d'une commande (Jaeger : Tags order.id=<uuid>).
  app.addHook('onRequest', async (req) => {
    const route = req.routeOptions?.url;
    const span = trace.getActiveSpan();
    if (route && span) {
      span.updateName(`${req.method} ${route}`);
      span.setAttribute('http.route', route);
    }
  });
  app.addHook('preHandler', async (req) => {
    const orderId = req.body?.orderId ?? req.params?.id;
    if (orderId) tagOrder(orderId);
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/metrics', async (_req, reply) => {
    reply.type(register.contentType);
    return register.metrics();
  });

  return app;
}

export async function start(app, defaultPort) {
  const port = Number(process.env.PORT ?? defaultPort);
  await app.listen({ host: '0.0.0.0', port });

  const shutdown = async () => {
    await app.close();
    await pool.end();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

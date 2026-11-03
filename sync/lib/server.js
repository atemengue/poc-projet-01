import { setTimeout as sleep } from 'node:timers/promises';
import Fastify from 'fastify';
import { logger } from './logger.js';
import { register } from './metrics.js';
import { pool } from './db.js';

/** Retourne une fonction qui attend la latence simulée du service (défaut du domain.js, surcharge par env). */
export function simulatedLatency(defaultMs) {
  const ms = Number(process.env.SIMULATED_LATENCY_MS ?? defaultMs);
  return () => (ms > 0 ? sleep(ms) : Promise.resolve());
}

export function createServer() {
  // Pas de log par requête : à 500 cmd/s il coûterait du CPU et brouillerait la mesure.
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true });

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

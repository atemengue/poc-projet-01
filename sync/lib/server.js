import { setTimeout as sleep } from 'node:timers/promises';
import Fastify from 'fastify';
import { trace } from '@opentelemetry/api';
import { logger } from './logger.js';
import { register, inflightRequests } from './metrics.js';
import { pool } from './db.js';

// Latence injectée pendant un run (K1, S3) par POST /admin/chaos ; null = latence normale.
let chaosLatencyMs = null;

/**
 * Retourne une fonction qui attend la latence simulée du service : défaut du domain.js,
 * surchargé par SIMULATED_LATENCY_MS, et remplacé pendant un run par /admin/chaos.
 */
export function simulatedLatency(defaultMs) {
  const ms = Number(process.env.SIMULATED_LATENCY_MS ?? defaultMs);
  return () => {
    const wait = chaosLatencyMs ?? ms;
    return wait > 0 ? sleep(wait) : Promise.resolve();
  };
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

  // H1, H3c : requêtes en cours (hors routes techniques).
  const counted = (req) => !/^\/(health|metrics|admin)/.test(req.url);
  app.addHook('onRequest', async (req) => { if (counted(req)) inflightRequests.inc(); });
  app.addHook('onResponse', async (req) => { if (counted(req)) inflightRequests.dec(); });

  // K1 (S3) : latence du service changée pendant un run. { latencyMs: 2000 } pour ralentir,
  // { latencyMs: null } pour revenir à la latence normale.
  app.post('/admin/chaos', {
    schema: {
      body: {
        type: 'object',
        required: ['latencyMs'],
        properties: { latencyMs: { type: ['integer', 'null'], minimum: 0 } },
      },
    },
  }, async (req) => {
    chaosLatencyMs = req.body.latencyMs;
    req.log.warn({ latencyMs: chaosLatencyMs }, 'chaos latency set');
    return { latencyMs: chaosLatencyMs };
  });
  app.get('/admin/chaos', async () => ({ latencyMs: chaosLatencyMs }));

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

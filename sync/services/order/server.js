import { createServer, start, tagOrder } from '../../lib/server.js';
import { duplicatesDetected } from '../../lib/metrics.js';
import { pool, withTransaction } from '../../lib/db.js';
import { UpstreamError } from '../../lib/http-client.js';
import * as domain from './domain.js';
import { processOrder } from './workflow.js';

const app = createServer();

// Instant d'arrivée, noté au tout premier point d'entrée de Fastify (avant la lecture du
// corps, la validation, l'attente du pool et la lecture des prix) : départ des latences (C3).
const markReceived = (req, _reply, done) => {
  req.receivedAt = new Date();
  done();
};

// K2 (S5 symétrique, H4) : un client qui renvoie sa requête avec le même en-tête
// Idempotency-Key reçoit la réponse mémorisée, sans nouveau traitement. Désactivable
// (IDEMPOTENCY=off) pour le témoin. Seules les réponses 201 sont mémorisées : une commande
// en échec (502) n'est pas rejouée par la suite (pas de résilience ajoutée, CLAUDE.md §6).
const IDEMPOTENCY = (process.env.IDEMPOTENCY ?? 'on') !== 'off';

async function storedResponse(key) {
  const { rows } = await pool.query(
    "SELECT response FROM idempotency_keys WHERE service = 'order' AND key = $1", [key]);
  return rows[0]?.response ?? null;
}

async function storeResponse(key, body) {
  await pool.query(
    `INSERT INTO idempotency_keys (service, key, response) VALUES ('order', $1, $2)
     ON CONFLICT (service, key) DO NOTHING`, [key, body]);
}

// Réponse après le workflow complet : 201 si la commande atteint un état terminal
// (CONFIRMED ou REJECTED), 502 si une dépendance a échoué avant.
app.post('/orders', { onRequest: markReceived }, async (req, reply) => {
  const { receivedAt } = req;
  const idemKey = IDEMPOTENCY ? req.headers['idempotency-key'] : undefined;
  if (idemKey) {
    const previous = await storedResponse(idemKey);
    if (previous) {
      duplicatesDetected.inc();
      req.log.info({ orderId: previous.orderId, idempotencyKey: idemKey }, 'duplicate request answered from idempotency_keys');
      return reply.code(201).header('idempotent-replay', 'true').send(previous);
    }
  }
  const { value, errors } = domain.validateOrderRequest(req.body);
  if (errors) return reply.code(400).send({ error: 'INVALID_REQUEST', details: errors });

  const priced = await domain.priceItems(pool, value.items);
  if (priced.unknownSkus) {
    return reply.code(400).send({ error: 'UNKNOWN_SKU', details: priced.unknownSkus });
  }

  const order = { ...value, ...priced, receivedAt };
  const orderId = await withTransaction((client) => domain.createOrder(client, order));
  tagOrder(orderId);
  const log = req.log.child({ orderId });

  try {
    const result = await processOrder({ ...order, orderId }, log);
    log.info({ status: result.status, rejectionReason: result.rejectionReason }, 'order processed');
    const body = { orderId, ...result };
    if (idemKey) await storeResponse(idemKey, body);
    return reply.code(201).send(body);
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    const current = await domain.getOrder(pool, orderId);
    log.error({ err: err.message, status: current.status }, 'order processing failed');
    return reply.code(502).send({ orderId, status: current.status, error: 'UPSTREAM_FAILURE', details: err.message });
  }
});

app.get('/orders/:id', {
  schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
}, async (req, reply) => {
  const order = await domain.getOrder(pool, req.params.id);
  if (!order) return reply.code(404).send({ error: 'NOT_FOUND' });
  return order;
});

await start(app, 3000);

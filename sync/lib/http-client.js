import { Agent, request } from 'undici';
import client from 'prom-client';
import { register } from './metrics.js';

const TIMEOUT_MS = Number(process.env.OUTBOUND_TIMEOUT_MS ?? 5000);

// Pool de connexions sortantes, partagé par tous les appels du service.
const agent = new Agent({ connections: Number(process.env.OUTBOUND_CONNECTIONS ?? 64) });

// H1, H3c : appels sortants en attente d'une connexion libre, par service appelé (PC4).
// C'est l'équivalent synchrone de la profondeur de file de async/.
new client.Gauge({
  name: 'outbound_pool_pending',
  help: 'Appels sortants en attente d\'une connexion du pool, par cible',
  labelNames: ['target'],
  registers: [register],
  collect() {
    this.reset();
    for (const [origin, stats] of Object.entries(agent.stats)) {
      this.set({ target: new URL(origin).hostname }, stats.pending ?? 0);
    }
  },
});

// Dépendance injoignable, délai dépassé ou réponse non 2xx.
export class UpstreamError extends Error {
  constructor(url, reason, options) {
    super(`${url}: ${reason}`, options);
    this.name = 'UpstreamError';
    this.url = url;
    this.reason = reason;
  }
}

export async function postJson(url, body) {
  let res;
  try {
    res = await request(url, {
      method: 'POST',
      dispatcher: agent,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(url, err.code ?? err.name, { cause: err });
  }
  const data = await res.body.json().catch(() => null);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new UpstreamError(url, `HTTP ${res.statusCode}`);
  }
  return data;
}

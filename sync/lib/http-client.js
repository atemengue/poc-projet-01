import { Agent, request } from 'undici';

const TIMEOUT_MS = Number(process.env.OUTBOUND_TIMEOUT_MS ?? 5000);

// Pool de connexions sortantes, partagé par tous les appels du service.
const agent = new Agent({ connections: Number(process.env.OUTBOUND_CONNECTIONS ?? 64) });

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

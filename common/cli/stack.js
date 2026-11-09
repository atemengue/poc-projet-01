// Outils de la CLI ./poc : appels Docker Compose, état des variantes, requêtes HTTP.
import { execFile, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const PROJECTS = ['sync', 'async'];
export const SERVICES = ['order', 'payment', 'inventory', 'shipping', 'notification'];
export const SERVICE_PORTS = { order: 3000, payment: 3001, inventory: 3002, shipping: 3003, notification: 3004 };
export const URLS = {
  prometheus: process.env.PROMETHEUS_URL ?? 'http://localhost:9090',
  jaeger: process.env.JAEGER_URL ?? 'http://localhost:16686',
  grafana: 'http://localhost:3100',
  rabbitmq: 'http://localhost:15672',
};

const exec = promisify(execFile);
const composeFile = (project) => (project === 'obs'
  ? join(ROOT, 'common/infra/docker-compose.yml')
  : join(ROOT, project, 'docker-compose.yml'));

/** docker compose … : sortie capturée. */
export async function compose(project, args, env = {}) {
  const { stdout } = await exec('docker', ['compose', '-f', composeFile(project), ...args],
    { env: { ...process.env, ...env }, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

/** docker compose … : sortie affichée en direct (build, up, logs). Résout avec le code de sortie. */
export function composeLive(project, args, env = {}) {
  return new Promise((res) => {
    const child = spawn('docker', ['compose', '-f', composeFile(project), ...args],
      { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('close', (code) => res(code));
  });
}

/** Conteneurs d'un projet : [{ service, state, health }]. */
export async function containers(project) {
  const out = await compose(project, ['ps', '-a', '--format', 'json']).catch(() => '');
  return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .map((c) => ({ service: c.Service, state: c.State, health: c.Health || '', status: c.Status }));
}

/** Variante active (sync ou async), ou null. Lève une erreur si les deux tournent. */
export async function activeProject() {
  const running = [];
  for (const p of PROJECTS) {
    if ((await containers(p)).some((c) => c.state === 'running' && SERVICES.includes(c.service))) running.push(p);
  }
  if (running.length > 1) throw new Error('sync et async tournent en même temps : un seul projet à la fois (./poc down)');
  return running[0] ?? null;
}

export async function requireActive() {
  const p = await activeProject();
  if (!p) throw new Error('aucune variante démarrée : ./poc up sync ou ./poc up async');
  return p;
}

export async function http(url, { method = 'GET', body, timeoutMs = 5000, headers = {} } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* corps non JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, error: err.cause?.code ?? err.name };
  }
}

/** Lance un script Node de common/scripts en relayant sa sortie ; résout avec son code de sortie. */
export function runScript(script, args = []) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [join(ROOT, 'common/scripts', script), ...args], { stdio: 'inherit', cwd: ROOT });
    child.on('close', (code) => res(code ?? 1));
  });
}

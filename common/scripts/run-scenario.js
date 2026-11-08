// Exécute un scénario de bout en bout, selon le protocole de CLAUDE.md §8 et PC1–PC5
// (docs/decisions-conception.md) :
//   contrôles préalables → réglages du run → reset → k6 (+ panne au bon moment) → drainage
//   → invariants → latences par phase → métriques Prometheus → ressources → traces (S1) → run.json
//
//   node common/scripts/run-scenario.js --project sync|async --scenario s1|s2|s3|s4|s4b|s5 --rep <n>
//        [--witness]   S5 seulement : protection d'idempotence désactivée (témoin)
//        [--tag <txt>] suffixe du dossier de sortie (ex. essai à blanc)
//
// Sorties : results/<projet>/<scénario>/rep-<n>[-<tag>]/ (run.json, k6-summary.json, invariants.json,
// latency.json, prometheus.json, resources.json, traces.json). Ne remplace jamais un dossier existant.
// Code de sortie : 0 run valide, 1 run invalide (à refaire), 2 run impossible.
import { spawn, execFile } from 'node:child_process';
import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROFILES, timeline, totalSeconds } from '../benchmarks/profiles.js';
import { connect, describeError } from './db.js';
import { reset, purgeQueues } from './reset.js';
import { measure, measureSlices } from './latency.js';
import { compareDomains, compareConfig } from './check-parity.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const K6_IMAGE = 'grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8';
const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const JAEGER = process.env.JAEGER_URL ?? 'http://localhost:16686';
const SERVICE_PORTS = { order: 3000, payment: 3001, inventory: 3002, shipping: 3003, notification: 3004 };
const DRAIN_MAX_S = 600;   // PC1 : drainage plafonné à 10 min
const DRAIN_IDLE_S = 30;   // fin du drainage si plus rien ne bouge pendant 30 s (commandes bloquées)
const DROPPED_LIMIT = 0.01; // CLAUDE.md §8 : ≥ 1 % d'itérations perdues = run invalide
const FAULT_TOLERANCE_MS = 5000; // R1 : panne posée ou levée à plus de 5 s de l'heure prévue = run invalide

const exec = promisify(execFile);
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ------------------------------------------------------------------ outils

const compose = (project, ...args) => exec('docker', ['compose', '-f', join(ROOT, project, 'docker-compose.yml'), ...args],
  { maxBuffer: 20 * 1024 * 1024, env: process.env });

async function composeUp(project, env) {
  await promisify(execFile)('docker', ['compose', '-f', join(ROOT, project, 'docker-compose.yml'), 'up', '-d', '--wait'],
    { env: { ...process.env, ...env }, maxBuffer: 20 * 1024 * 1024 });
}

async function runningServices(project) {
  const { stdout } = await compose(project, 'ps', '--format', 'json');
  return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((c) => c.State === 'running').map((c) => c.Service);
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function setChaos(service, latencyMs) {
  const res = await fetch(`http://localhost:${SERVICE_PORTS[service]}/admin/chaos`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ latencyMs }),
  });
  if (!res.ok) throw new Error(`chaos ${service} : HTTP ${res.status}`);
}

async function promRange(query, start, end) {
  const qs = new URLSearchParams({ query, start: String(start / 1000), end: String(end / 1000), step: '5' });
  const res = await fetch(`${PROMETHEUS}/api/v1/query_range?${qs}`);
  if (!res.ok) return { query, error: `HTTP ${res.status}` };
  const body = await res.json();
  return { query, series: body.data?.result ?? [] };
}

// ------------------------------------------------------------------ étapes

async function preflight(project, other) {
  const checks = {};
  const up = await runningServices(project);
  const expected = ['postgres', 'order', 'payment', 'inventory', 'shipping', 'notification', ...(project === 'async' ? ['rabbitmq'] : [])];
  const missing = expected.filter((s) => !up.includes(s));
  if (missing.length) throw new Error(`${project} : services arrêtés : ${missing.join(', ')} (docker compose -f ${project}/docker-compose.yml up -d --wait)`);
  if ((await runningServices(other)).length) throw new Error(`${other} tourne aussi : un seul projet à la fois (docker compose -f ${other}/docker-compose.yml down)`);

  // C-4 : observabilité vivante.
  checks.prometheus = await httpOk(`${PROMETHEUS}/-/ready`);
  checks.jaeger = await httpOk(`${JAEGER}/api/services`);
  if (!checks.prometheus) throw new Error('Prometheus injoignable : docker compose -f common/infra/docker-compose.yml up -d');

  // Parité (étape 5) : le run n'est valable que si seul le style diffère.
  const domains = await compareDomains(join(ROOT, 'sync'), join(ROOT, 'async'));
  const cfg = (p) => compose(p, 'config', '--format', 'json').then(({ stdout }) => JSON.parse(stdout));
  const config = compareConfig(await cfg('sync'), await cfg('async'));
  checks.parity = domains.every((d) => d.identical) && config.every((c) => c.ok);
  if (!checks.parity) throw new Error('parité rompue : lancer (cd common && npm run parity)');
  return checks;
}

function runParams(project, scenario, witness) {
  return {
    TRACE_RATIO: scenario === 's5' ? '1.0' : '0.1',                    // PC3
    IDEMPOTENCY: witness ? 'off' : 'on',                               // PC5, K2/K3
    ...(project === 'async' ? { DUPLICATE_DELIVERY: scenario === 's5' ? '2' : '1' } : {}), // K3
  };
}

function startK6({ project, scenario, runId, outRel }) {
  const args = ['run', '--rm', '--network', 'poc-net',
    '-v', `${join(ROOT, 'common/benchmarks')}:/scripts:ro`, '-v', `${join(ROOT, 'results')}:/results`,
    '-e', 'K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write',
    '-e', 'K6_PROMETHEUS_RW_TREND_STATS=p(50),p(95),p(99),avg,max',
    K6_IMAGE, 'run', '-q', '-o', 'experimental-prometheus-rw', '--tag', `testid=${runId}`,
    '-e', `RUN_ID=${runId}`, '-e', `PROFILE=${scenario}`,
    ...(project === 'sync' && scenario === 's5' ? ['-e', 'DUPLICATE=2'] : []),
    '--summary-export', `/results/${outRel}/k6-summary.json`, '/scripts/place-order.js'];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const done = new Promise((res) => child.on('close', (code) => res({ code, output })));
  return { done };
}

/** Instant réel du début du run : réception de la première commande (horloge de la base). */
async function firstOrderAt(client, runId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows: [r] } = await client.query('SELECT min(received_at) AS t FROM orders WHERE customer_id LIKE $1', [`${runId}-%`]);
    if (r.t) return r.t.getTime();
    await sleep(200);
  }
  throw new Error('aucune commande reçue 60 s après le lancement de k6');
}

// R1 : l'heure réelle de pose et de levée de la panne est relevée une fois l'action terminée
// (conteneur arrêté ou redémarré, latence changée) et comparée à l'heure prévue. Lors d'un
// essai sync S3, la levée était arrivée 6 min trop tard : le scénario joué n'était plus S3.
async function injectFault(project, fault, phase, t0, events) {
  const at = (ms) => sleep(Math.max(0, t0 + ms - Date.now()));
  const timing = {};

  await at(phase.start * 1000);
  if (fault.kind === 'latency') await setChaos(fault.service, fault.latencyMs);
  else await compose(project, 'stop', fault.service);
  timing.plannedStart = new Date(t0 + phase.start * 1000).toISOString();
  timing.actualStart = new Date().toISOString();
  timing.startDelayMs = Date.now() - (t0 + phase.start * 1000);
  events.push({ event: 'fault-start', fault, at: timing.actualStart });
  log(`panne : ${fault.kind} ${fault.service} (écart ${timing.startDelayMs} ms)`);

  await at(phase.end * 1000);
  if (fault.kind === 'latency') await setChaos(fault.service, null);
  else await compose(project, 'start', fault.service);
  timing.plannedEnd = new Date(t0 + phase.end * 1000).toISOString();
  timing.actualEnd = new Date().toISOString();
  timing.endDelayMs = Date.now() - (t0 + phase.end * 1000);
  events.push({ event: 'fault-end', fault, at: timing.actualEnd });
  log(`fin de panne : ${fault.service} (écart ${timing.endDelayMs} ms)`);
  return timing;
}

/** Attend que toutes les commandes du run soient terminées, ou que plus rien ne bouge. */
async function drain(client, runId) {
  const started = Date.now();
  let last = null;
  let lastChange = Date.now();
  for (;;) {
    const { rows: [r] } = await client.query(
      `SELECT count(*) FILTER (WHERE status IN ('RECEIVED', 'ACCEPTED'))::int AS pending,
              count(*) FILTER (WHERE status = 'CONFIRMED' AND completed_at IS NULL)::int AS incomplete,
              count(*) FILTER (WHERE completed_at IS NOT NULL OR status = 'REJECTED')::int AS done
         FROM orders WHERE customer_id LIKE $1`, [`${runId}-%`]);
    const elapsed = (Date.now() - started) / 1000;
    if (r.pending === 0 && r.incomplete === 0) return { seconds: elapsed, reason: 'toutes les commandes sont terminées', ...r };
    const key = `${r.pending}/${r.incomplete}/${r.done}`;
    if (key !== last) { last = key; lastChange = Date.now(); }
    if ((Date.now() - lastChange) / 1000 >= DRAIN_IDLE_S) return { seconds: elapsed, reason: `plus de progression depuis ${DRAIN_IDLE_S} s (commandes bloquées)`, ...r };
    if (elapsed >= DRAIN_MAX_S) return { seconds: elapsed, reason: 'plafond de 10 min atteint', ...r };
    await sleep(1000);
  }
}

function k6Summary(summary, profile) {
  const m = summary.metrics ?? {};
  const iterations = m.iterations?.count ?? 0;
  const dropped = m.dropped_iterations?.count ?? 0;
  const phases = {};
  for (const p of profile.phases) {
    const dur = m[`http_req_duration{name:POST /orders,phase:${p.name}}`] ?? {};
    phases[p.name] = {
      requests: m[`http_reqs{name:POST /orders,phase:${p.name}}`]?.count ?? 0,
      clientTimeouts: m[`client_timeouts{phase:${p.name}}`]?.count ?? 0,
      httpP50: dur.med ?? null, httpP95: dur['p(95)'] ?? null, httpP99: dur['p(99)'] ?? null,
      ...(profile.probe ? { probeP95: m[`http_req_duration{name:GET /orders/:id,phase:${p.name}}`]?.['p(95)'] ?? null } : {}),
    };
  }
  return { iterations, dropped, droppedRatio: iterations + dropped ? dropped / (iterations + dropped) : 0, phases };
}

/** Ressources des conteneurs (CPU, mémoire), y compris PostgreSQL et RabbitMQ, toutes les 5 s. */
function sampleResources(project) {
  const samples = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const { stdout } = await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
        const at = new Date().toISOString();
        for (const line of stdout.trim().split('\n')) {
          const s = JSON.parse(line);
          if (s.Name.startsWith(`poc-${project}-`)) samples.push({ at, name: s.Name, cpu: s.CPUPerc, mem: s.MemUsage });
        }
      } catch { /* échantillon manqué */ }
      await sleep(5000);
    }
  })();
  return async () => { stop = true; await loop; return samples; };
}

// ------------------------------------------------------------------ programme

const { values: args } = parseArgs({
  options: {
    project: { type: 'string' }, scenario: { type: 'string' }, rep: { type: 'string', default: '1' },
    witness: { type: 'boolean', default: false }, tag: { type: 'string' },
  },
});
const { project, scenario } = args;
const profile = PROFILES[scenario];
if (!['sync', 'async'].includes(project) || !profile || !/^\d+$/.test(args.rep) || (args.witness && scenario !== 's5')) {
  console.error('usage : node common/scripts/run-scenario.js --project sync|async --scenario s1|s2|s3|s4|s4b|s5 --rep <n> [--witness] [--tag <txt>]');
  console.error('        --witness : S5 seulement');
  process.exit(2);
}
const other = project === 'sync' ? 'async' : 'sync';
const runId = `${project}-${scenario}${args.witness ? '-witness' : ''}-r${args.rep}`;
const outRel = join(project, scenario, `rep-${args.rep}${args.witness ? '-witness' : ''}${args.tag ? `-${args.tag}` : ''}`);
const outDir = join(ROOT, 'results', outRel);

let client;
try {
  if (await access(outDir).then(() => true, () => false)) throw new Error(`${outDir} existe déjà : on ne remplace jamais un résultat (choisir une autre --rep ou --tag)`);
  const run = { project, scenario, rep: Number(args.rep), witness: args.witness, runId, profile, events: [] };

  log(`${runId} : contrôles préalables`);
  run.preflight = await preflight(project, other);
  // Dossier créé seulement après les contrôles : un run refusé ne laisse pas de dossier vide.
  await mkdir(outDir, { recursive: true });

  run.params = runParams(project, scenario, args.witness);
  log(`réglages du run : ${JSON.stringify(run.params)}`);
  await composeUp(project, run.params);
  await setChaos('payment', null);

  await purgeQueues();
  client = await connect();
  await reset(client);
  log('base et files remises à zéro');

  const stopResources = sampleResources(project);
  log(`k6 : profil ${scenario}, ${totalSeconds(profile)} s`);
  const k6 = startK6({ project, scenario, runId, outRel });
  const t0 = await firstOrderAt(client, runId);
  run.startedAt = new Date(t0).toISOString();
  run.timeline = timeline(profile).map((p) => ({ ...p, from: new Date(t0 + p.start * 1000).toISOString(), to: new Date(t0 + p.end * 1000).toISOString() }));

  if (profile.fault) {
    const phase = timeline(profile).find((p) => p.name === 'fault');
    run.faultTiming = await injectFault(project, profile.fault, phase, t0, run.events);
  }
  const { code, output } = await k6.done;
  run.k6ExitCode = code;
  if (code !== 0) run.k6Output = output.slice(-4000);
  log(`k6 terminé (code ${code})`);

  log('drainage…');
  run.drain = await drain(client, runId);
  log(`drainage : ${Math.round(run.drain.seconds)} s, ${run.drain.reason}`);
  const end = Date.now();
  run.resourcesFile = 'resources.json';
  await writeFile(join(outDir, 'resources.json'), `${JSON.stringify(await stopResources(), null, 2)}\n`);

  log('invariants');
  const verify = await exec('node', [join(ROOT, 'common/scripts/verify-invariants.js'), '--out', join(outDir, 'invariants.json')])
    .then(() => 0, (e) => e.code);
  run.invariantsExitCode = verify;

  log('latences');
  const latency = { measure: await measure(client, runId, profile.measure), byPhase: {} };
  for (const p of profile.phases) latency.byPhase[p.name] = await measure(client, runId, [p.name]);
  latency.slices10s = await measureSlices(client, runId, 10);
  await writeFile(join(outDir, 'latency.json'), `${JSON.stringify(latency, null, 2)}\n`);

  log('métriques Prometheus');
  const queries = [
    'rate(process_cpu_seconds_total{job="services"}[30s])',
    'process_resident_memory_bytes{job="services"}',
    'nodejs_eventloop_lag_p99_seconds{job="services"}',
    'inflight_requests',
    'outbound_pool_pending',
    'duplicates_detected_total',
    'rabbitmq_queue_messages_ready',
    'rabbitmq_queue_messages_unacked',
  ];
  const prom = [];
  for (const q of queries) prom.push(await promRange(q, t0, end));
  await writeFile(join(outDir, 'prometheus.json'), `${JSON.stringify(prom, null, 2)}\n`);

  if (scenario === 's1') {
    log('traces (H5)');
    run.tracesExitCode = await exec('node', [join(ROOT, 'common/scripts/trace-completeness.js'), '--project', project,
      '--run', runId, '--phase', 'measure', '--out', join(outDir, 'traces.json')]).then(() => 0, (e) => e.code);
  }

  // Validité du run (CLAUDE.md §8).
  const summary = JSON.parse(await readFile(join(outDir, 'k6-summary.json'), 'utf8'));
  run.k6 = k6Summary(summary, profile);
  const reasons = [];
  if (run.k6.droppedRatio >= DROPPED_LIMIT) reasons.push(`itérations perdues : ${(run.k6.droppedRatio * 100).toFixed(2)} % ≥ 1 %`);
  if (code !== 0) reasons.push(`k6 a échoué (code ${code})`);
  if (verify === 2) reasons.push('vérification des invariants impossible');
  if (run.faultTiming) {
    const { startDelayMs, endDelayMs } = run.faultTiming;
    if (Math.abs(startDelayMs) > FAULT_TOLERANCE_MS) reasons.push(`panne posée avec ${startDelayMs} ms d'écart (> ${FAULT_TOLERANCE_MS} ms)`);
    if (Math.abs(endDelayMs) > FAULT_TOLERANCE_MS) reasons.push(`panne levée avec ${endDelayMs} ms d'écart (> ${FAULT_TOLERANCE_MS} ms)`);
  }
  run.valid = reasons.length === 0;
  run.invalidReasons = reasons;
  // H3b : perdues = requêtes envoyées par k6 dans la phase mesurée, absentes de la base.
  const sent = profile.measure.reduce((n, p) => n + run.k6.phases[p].requests, 0) / (project === 'sync' && scenario === 's5' ? 2 : 1);
  run.lost = Math.max(0, sent - latency.measure.total);
  run.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);

  log(`run ${run.valid ? 'VALIDE' : `INVALIDE (${reasons.join(' ; ')})`} → results/${outRel}/`);
  process.exitCode = run.valid ? 0 : 1;
} catch (err) {
  console.error(`run impossible : ${describeError(err)}`);
  process.exitCode = 2;
} finally {
  await client?.end().catch(() => {});
  // Retour aux réglages par défaut (traces à 100 %, idempotence active, pas de doublons) et à la latence normale.
  if (project) {
    await setChaos('payment', null).catch(() => {});
    await composeUp(project, {}).catch(() => {});
  }
}

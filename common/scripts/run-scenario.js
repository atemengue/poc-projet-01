// Exécute un scénario de bout en bout, selon le protocole de CLAUDE.md §8 et PC1–PC5
// (docs/decisions-conception.md) :
//   contrôles préalables → réglages du run → reset → k6 (+ panne au bon moment) → drainage
//   → invariants → latences par phase → métriques Prometheus → ressources → traces (S1) → run.json
//
//   node common/scripts/run-scenario.js --project sync|async --scenario s1|s2|s3|s4|s4b|s5 --rep <n>
//        [--witness]        S5 seulement : doublons, protection d'idempotence désactivée (témoin)
//        [--no-duplicates]  S5 seulement : sans doublons, référence pour le surcoût de H4
//        [--tag <txt>] suffixe du dossier de sortie (ex. essai à blanc)
//
// Sorties : results/<projet>/<scénario>/rep-<n>[-<tag>]/ (run.json, k6-summary.json, invariants.json,
// latency.json, prometheus.json, resources.json, traces.json). Ne remplace jamais un dossier existant.
// Validité (CLAUDE.md §8, PC7) : « valide » si k6 a perdu moins de 1 % des itérations ;
// « valide sous saturation » si ≥ 1 % mais que c'est le système qui sature (VUs de k6 tous
// occupés, abandons côté client ≥ 1 %, k6 sous ses limites de ressources) : un tel run ne peut
// servir qu'à REJETER une hypothèse (moins de charge ne fait qu'avantager le système) ; sinon
// « invalide », à refaire.
// Code de sortie : 0 run valide ou valide sous saturation, 1 run invalide (à refaire), 2 run impossible.
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

async function promInstant(query) {
  try {
    const res = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(query)}`);
    const body = await res.json();
    return Number(body.data?.result?.[0]?.value?.[1] ?? 0);
  } catch {
    return null;
  }
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

/** S5 : doublons produits (broker en async, renvoi par k6 en sync), sauf pour la référence. */
const withDuplicates = (scenario, noDuplicates) => scenario === 's5' && !noDuplicates;

function runParams(project, scenario, witness, noDuplicates) {
  return {
    TRACE_RATIO: scenario === 's5' ? '1.0' : '0.1',                    // PC3
    IDEMPOTENCY: witness ? 'off' : 'on',                               // PC5, K2/K3
    ...(project === 'async' ? { DUPLICATE_DELIVERY: withDuplicates(scenario, noDuplicates) ? '2' : '1' } : {}), // K3
  };
}

// Conteneur k6 nommé, pour relever ses ressources avec celles des services (R2, PC7).
const k6Container = (runId) => `poc-k6-${runId}`;

function startK6({ project, scenario, runId, outRel, noDuplicates }) {
  const args = ['run', '--rm', '--name', k6Container(runId), '--network', 'poc-net',
    '-v', `${join(ROOT, 'common/benchmarks')}:/scripts:ro`, '-v', `${join(ROOT, 'results')}:/results`,
    '-e', 'K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write',
    '-e', 'K6_PROMETHEUS_RW_TREND_STATS=p(50),p(95),p(99),avg,max',
    K6_IMAGE, 'run', '-q', '-o', 'experimental-prometheus-rw', '--tag', `testid=${runId}`,
    '-e', `RUN_ID=${runId}`, '-e', `PROFILE=${scenario}`,
    ...(project === 'sync' && withDuplicates(scenario, noDuplicates) ? ['-e', 'DUPLICATE=2'] : []),
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
function sampleResources(project, runId) {
  const samples = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const { stdout } = await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
        const at = new Date().toISOString();
        for (const line of stdout.trim().split('\n')) {
          const s = JSON.parse(line);
          if (s.Name.startsWith(`poc-${project}-`) || s.Name === k6Container(runId)) {
            samples.push({ at, name: s.Name, cpu: s.CPUPerc, mem: s.MemUsage, memPerc: s.MemPerc });
          }
        }
      } catch { /* échantillon manqué */ }
      await sleep(5000);
    }
  })();
  return async () => { stop = true; await loop; return samples; };
}

/** CPU et mémoire maximaux du conteneur k6 pendant le run (relevés toutes les 5 s). */
function k6Resources(samples, name) {
  const mine = samples.filter((s) => s.name === name);
  const num = (v) => Number.parseFloat(String(v ?? '').replace('%', '')) || 0;
  return {
    samples: mine.length,
    cpuMaxPercent: mine.length ? Math.max(...mine.map((s) => num(s.cpu))) : null,
    memMaxPercent: mine.length ? Math.max(...mine.map((s) => num(s.memPerc))) : null,
  };
}

/**
 * PC7 : les itérations perdues viennent-elles du système ou de k6 ?
 * Système saturé : les VUs de k6 ont tous été occupés (≥ 95 % du plafond) et ≥ 1 % des requêtes
 * des phases mesurées ont atteint le délai client. k6 en bonne santé : ses ressources ont été
 * relevées et sa mémoire est restée sous 80 % de la mémoire disponible pour Docker.
 */
function systemSaturation(k6, profile) {
  const measured = profile.measure.map((p) => k6.phases[p]);
  const requests = measured.reduce((n, p) => n + p.requests, 0);
  const timeouts = measured.reduce((n, p) => n + p.clientTimeouts, 0);
  const vusFull = k6.vusMaxReached !== null && k6.vusCeiling !== null && k6.vusMaxReached >= 0.95 * k6.vusCeiling;
  const timeoutRatio = requests ? timeouts / requests : 0;
  const system = vusFull && timeoutRatio >= 0.01;
  const k6Healthy = k6.resources.samples > 0 && k6.resources.memMaxPercent !== null && k6.resources.memMaxPercent < 80;
  const explanation = !k6.resources.samples ? 'ressources de k6 non relevées'
    : !system ? `système non saturé (VUs ${k6.vusMaxReached}/${k6.vusCeiling}, abandons ${(timeoutRatio * 100).toFixed(1)} %)`
      : !k6Healthy ? `k6 lui-même en limite de mémoire (${k6.resources.memMaxPercent} %)` : '';
  return { system, k6Healthy, vusFull, timeoutRatio, explanation };
}

// ------------------------------------------------------------------ programme

const { values: args } = parseArgs({
  options: {
    project: { type: 'string' }, scenario: { type: 'string' }, rep: { type: 'string', default: '1' },
    witness: { type: 'boolean', default: false }, 'no-duplicates': { type: 'boolean', default: false },
    tag: { type: 'string' },
  },
});
const { project, scenario } = args;
const profile = PROFILES[scenario];
const noDuplicates = args['no-duplicates'];
if (!['sync', 'async'].includes(project) || !profile || !/^\d+$/.test(args.rep)
    || ((args.witness || noDuplicates) && scenario !== 's5') || (args.witness && noDuplicates)) {
  console.error('usage : node common/scripts/run-scenario.js --project sync|async --scenario s1|s2|s3|s4|s4b|s5 --rep <n> [--witness | --no-duplicates] [--tag <txt>]');
  console.error('        --witness, --no-duplicates : S5 seulement, l\'un ou l\'autre');
  process.exit(2);
}
const other = project === 'sync' ? 'async' : 'sync';
const variant = args.witness ? '-witness' : noDuplicates ? '-nodup' : '';
const runId = `${project}-${scenario}${variant}-r${args.rep}`;
const outRel = join(project, scenario, `rep-${args.rep}${variant}${args.tag ? `-${args.tag}` : ''}`);
const outDir = join(ROOT, 'results', outRel);

let client;
try {
  if (await access(outDir).then(() => true, () => false)) throw new Error(`${outDir} existe déjà : on ne remplace jamais un résultat (choisir une autre --rep ou --tag)`);
  const run = { project, scenario, rep: Number(args.rep), witness: args.witness, noDuplicates, runId, profile, events: [] };

  // Rappel du scénario en cours et des hypothèses qu'il permet d'évaluer.
  const rule = '─'.repeat(78);
  const kind = args.witness ? ', témoin : doublons sans protection' : noDuplicates ? ', référence : sans doublons' : '';
  console.log(`${rule}\n${profile.title}  [${project}${kind}, répétition ${args.rep}]`);
  console.log(`  Charge    : ${profile.load}`);
  console.log(`  Action    : ${profile.action}`);
  console.log(`  Question  : ${profile.question}`);
  console.log(`  Durée     : ${totalSeconds(profile)} s de charge, puis drainage, invariants et mesures`);
  console.log('  Hypothèses évaluées :');
  for (const h of profile.hypotheses) console.log(`    - ${h}`);
  console.log(`  Résultats : results/${outRel}/\n${rule}`);

  log(`${runId} : contrôles préalables`);
  run.preflight = await preflight(project, other);
  // Dossier créé seulement après les contrôles : un run refusé ne laisse pas de dossier vide.
  await mkdir(outDir, { recursive: true });

  run.params = runParams(project, scenario, args.witness, noDuplicates);
  log(`réglages du run : ${JSON.stringify(run.params)}`);
  await composeUp(project, run.params);
  await setChaos('payment', null);

  await purgeQueues();
  client = await connect();
  await reset(client);
  log('base et files remises à zéro');

  // H4 : doublons écartés, mesurés comme la différence du compteur entre le début et la fin du run
  // (les conteneurs ne sont pas toujours redémarrés entre deux runs : le compteur n'est pas remis à 0).
  const duplicatesAtStart = scenario === 's5' ? await promInstant('sum(duplicates_detected_total)') : null;
  const stopResources = sampleResources(project, runId);
  log(`k6 : profil ${scenario}, ${totalSeconds(profile)} s`);
  const k6 = startK6({ project, scenario, runId, outRel, noDuplicates });
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
  const resources = await stopResources();
  await writeFile(join(outDir, 'resources.json'), `${JSON.stringify(resources, null, 2)}\n`);

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
  run.k6.vusMaxReached = summary.metrics?.vus?.max ?? null;
  run.k6.vusCeiling = summary.metrics?.vus_max?.max ?? null;
  run.k6.resources = k6Resources(resources, k6Container(runId));
  const reasons = [];
  let validity = 'valid';
  if (run.k6.droppedRatio >= DROPPED_LIMIT) {
    const saturation = systemSaturation(run.k6, profile);
    run.saturation = saturation;
    if (saturation.system && saturation.k6Healthy) {
      validity = 'valid-under-saturation';
      log(`itérations perdues ${(run.k6.droppedRatio * 100).toFixed(2)} % ≥ 1 %, mais le système sature et pas k6 : valide sous saturation (ne peut que rejeter)`);
    } else {
      reasons.push(`itérations perdues : ${(run.k6.droppedRatio * 100).toFixed(2)} % ≥ 1 % (${saturation.explanation})`);
    }
  }
  if (code !== 0) reasons.push(`k6 a échoué (code ${code})`);
  if (verify === 2) reasons.push('vérification des invariants impossible');
  if (run.faultTiming) {
    const { startDelayMs, endDelayMs } = run.faultTiming;
    if (Math.abs(startDelayMs) > FAULT_TOLERANCE_MS) reasons.push(`panne posée avec ${startDelayMs} ms d'écart (> ${FAULT_TOLERANCE_MS} ms)`);
    if (Math.abs(endDelayMs) > FAULT_TOLERANCE_MS) reasons.push(`panne levée avec ${endDelayMs} ms d'écart (> ${FAULT_TOLERANCE_MS} ms)`);
  }
  if (reasons.length) validity = 'invalid';
  run.validity = validity;
  run.valid = validity !== 'invalid';
  run.invalidReasons = reasons;
  // H3b : perdues = requêtes envoyées par k6 dans la phase mesurée, absentes de la base.
  const sent = profile.measure.reduce((n, p) => n + run.k6.phases[p].requests, 0)
    / (project === 'sync' && withDuplicates(scenario, noDuplicates) ? 2 : 1);
  run.lost = Math.max(0, sent - latency.measure.total);

  // H4 (S5) : doublons. En sync, un doublon non protégé crée une SECONDE commande pour la même
  // requête client (même customerId) : invisible pour I7, compté ici. En async, il produit des
  // effets en double sur la même commande : compté par I7. duplicates_detected_total compte les
  // doublons écartés par la protection (services redémarrés au début du run : compteur à zéro).
  if (scenario === 's5') {
    const { rows: [d] } = await client.query(
      `SELECT count(*)::int AS requests, count(*) FILTER (WHERE n > 1)::int AS duplicated, coalesce(sum(n - 1), 0)::int AS extra_orders
         FROM (SELECT customer_id, count(*) AS n FROM orders WHERE customer_id LIKE $1 GROUP BY customer_id) t`, [`${runId}-%`]);
    const inv = JSON.parse(await readFile(join(outDir, 'invariants.json'), 'utf8'));
    await sleep(6000); // laisser Prometheus collecter la dernière valeur (collecte toutes les 5 s)
    const atEnd = await promInstant('sum(duplicates_detected_total)');
    // Si les conteneurs ont été recréés pendant le run, le compteur est reparti de 0 : la valeur
    // de fin est alors le total du run.
    const prom = atEnd === null || duplicatesAtStart === null ? null
      : atEnd >= duplicatesAtStart ? atEnd - duplicatesAtStart : atEnd;
    run.duplicates = {
      clientRequests: d.requests,
      requestsWithDuplicateOrders: d.duplicated,
      extraOrders: d.extra_orders,
      i7Violations: inv.results.find((x) => x.id === 'I7')?.violations ?? null,
      i1Violations: inv.results.find((x) => x.id === 'I1')?.violations ?? null,
      duplicatesDetectedTotal: prom,
    };
    log(`doublons : ${JSON.stringify(run.duplicates)}`);
  }
  run.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);

  const label = { valid: 'VALIDE', 'valid-under-saturation': 'VALIDE SOUS SATURATION (ne peut que rejeter une hypothèse)' }[validity]
    ?? `INVALIDE (${reasons.join(' ; ')})`;
  log(`run ${label} → results/${outRel}/`);
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

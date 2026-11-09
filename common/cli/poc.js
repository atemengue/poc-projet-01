// CLI du POC : ./poc <commande> [options]   (./poc help pour la liste)
// Node 22, sans dépendance ajoutée. Les mesures elles-mêmes restent dans common/scripts/ :
// la CLI les pilote, elle ne les réimplémente pas.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import {
  ROOT, PROJECTS, SERVICES, SERVICE_PORTS, URLS,
  compose, composeLive, containers, activeProject, requireActive, http, runScript,
} from './stack.js';
import { compareDomains, compareConfig } from '../scripts/check-parity.js';

const ok = (b) => (b ? '✓' : '✗');
const say = (msg = '') => console.log(msg);

// ------------------------------------------------------------------ pilotage

async function cmdBuild([project]) {
  const targets = project ? [project] : PROJECTS;
  for (const p of targets) {
    if (!PROJECTS.includes(p)) throw new Error('usage : ./poc build [sync|async]');
    say(`construction de l'image ${p}…`);
    // L'image est construite par le service payment, puis réutilisée par les autres.
    if (await composeLive(p, ['build', 'payment'])) throw new Error(`construction de ${p} échouée`);
  }
}

async function cmdUp([project], opts) {
  if (!PROJECTS.includes(project)) throw new Error('usage : ./poc up sync|async [--build]');
  const other = project === 'sync' ? 'async' : 'sync';
  if ((await containers(other)).some((c) => c.state === 'running')) {
    say(`arrêt de ${other} (un seul projet à la fois, mêmes ports ; sa base est conservée)…`);
    await composeLive(other, ['down']);
  }
  if (!(await http(`${URLS.prometheus}/-/ready`)).ok) {
    say('démarrage de l\'observabilité (Jaeger, Collector, Prometheus, Grafana)…');
    await composeLive('obs', ['up', '-d']);
  }
  say(`démarrage de ${project}…`);
  const code = await composeLive(project, ['up', '-d', '--wait', ...(opts.build ? ['--build'] : [])]);
  if (code) throw new Error(`${project} n'a pas démarré (voir ./poc logs <service>)`);
  say(`\n${project} prêt. Suite : ./poc check`);
}

async function cmdDown(_args, opts) {
  if (opts.volumes) {
    say('ATTENTION : --volumes efface les bases de sync et d\'async (commandes, stock).');
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Confirmer en tapant « oui » : ');
      rl.close();
      if (answer.trim().toLowerCase() !== 'oui') { say('annulé'); return; }
    }
  }
  for (const p of PROJECTS) await composeLive(p, ['down', ...(opts.volumes ? ['--volumes'] : [])]);
  if (opts.obs) await composeLive('obs', ['down']);
  say(opts.obs ? 'tout est arrêté, observabilité comprise' : 'variantes arrêtées (observabilité laissée en marche ; --obs pour l\'arrêter)');
}

async function runParams(project) {
  const out = await compose(project, ['exec', '-T', 'payment', 'printenv']).catch(() => '');
  const env = Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const chaos = await http(`http://localhost:${SERVICE_PORTS.payment}/admin/chaos`);
  return {
    traces: env.OTEL_TRACES_SAMPLER_ARG ?? '?',
    idempotency: env.IDEMPOTENCY ?? '?',
    ...(project === 'async' ? { duplicates: env.DUPLICATE_DELIVERY ?? '?' } : {}),
    paymentLatency: chaos.ok ? (chaos.json?.latencyMs ?? 'normale') : '?',
  };
}

async function cmdStatus() {
  const project = await activeProject();
  say(`variante active : ${project ?? 'aucune'}`);
  for (const p of [...PROJECTS, 'obs']) {
    const list = await containers(p);
    if (!list.length) continue;
    say(`\n${p}`);
    for (const c of list) say(`  ${c.service.padEnd(16)} ${c.status}`);
  }
  const targets = await http(`${URLS.prometheus}/api/v1/targets?state=active`);
  if (targets.ok) {
    say('\ncibles Prometheus');
    for (const t of targets.json.data.activeTargets) say(`  ${ok(t.health === 'up')} ${t.labels.instance}`);
  }
  if (project) {
    const params = await runParams(project);
    say(`\nréglages du run : traces ${params.traces}, idempotence ${params.idempotency}`
      + `${params.duplicates ? `, doublons ×${params.duplicates}` : ''}, latence de Payment ${params.paymentLatency}`);
  }
}

/** Passe une commande et, en async, attend son état final. */
async function placeOrder({ customerId, items, quantity, card, wait = true }) {
  const res = await http(`http://localhost:${SERVICE_PORTS.order}/orders`, {
    method: 'POST',
    body: { customerId, items, quantity, paymentInformation: { cardToken: card }, shippingAddress: { line1: '1 rue X', city: 'Montreal' } },
    timeoutMs: 10000,
  });
  if (!res.json?.orderId || !wait) return { response: res, order: null };
  let order = null;
  for (let i = 0; i < 50; i += 1) {
    order = (await http(`http://localhost:${SERVICE_PORTS.order}/orders/${res.json.orderId}`)).json;
    // État final : complétée, ou rejetée ; pour un stock insuffisant, l'annulation du paiement
    // (compensation) arrive après le rejet en async : on l'attend aussi.
    const compensated = order?.rejectionReason !== 'INSUFFICIENT_STOCK' || order?.paymentStatus === 'VOIDED';
    if (order && (order.completedAt || (order.status === 'REJECTED' && compensated))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { response: res, order };
}

async function cmdCheck() {
  const project = await requireActive();
  let failures = 0;
  const line = (good, label, detail = '') => { if (!good) failures += 1; say(`  ${ok(good)} ${label}${detail ? `  ${detail}` : ''}`); };

  say(`variante : ${project}\n\nservices`);
  for (const s of SERVICES) {
    const h = await http(`http://localhost:${SERVICE_PORTS[s]}/health`);
    line(h.ok, s, h.ok ? '' : `(HTTP ${h.status} ${h.error ?? ''})`);
  }
  say('\ninfrastructure');
  line((await http(`${URLS.prometheus}/-/ready`)).ok, 'Prometheus', URLS.prometheus);
  line((await http(`${URLS.jaeger}/api/services`)).ok, 'Jaeger', URLS.jaeger);
  if (project === 'async') {
    const q = await http(`${URLS.rabbitmq}/api/queues/%2F`, { headers: { authorization: `Basic ${Buffer.from('poc:poc').toString('base64')}` } });
    const dlq = q.ok ? q.json.filter((x) => x.name.endsWith('.dlq')).reduce((n, x) => n + (x.messages ?? 0), 0) : null;
    line(q.ok, 'RabbitMQ', q.ok ? `${q.json.length} files, ${dlq} message(s) en DLQ` : '');
  }

  say('\nparité sync / async');
  const domains = await compareDomains(join(ROOT, 'sync'), join(ROOT, 'async'));
  const cfg = async (p) => JSON.parse(await compose(p, ['config', '--format', 'json']));
  const config = compareConfig(await cfg('sync'), await cfg('async'));
  line(domains.every((d) => d.identical), 'domain.js identiques');
  line(config.every((c) => c.ok), 'configuration équitable', `(${config.filter((c) => c.ok).length}/${config.length})`);

  say('\ncommandes témoins (à effacer ensuite avec ./poc reset)');
  const cases = [
    { label: 'paiement autorisé', items: ['SKU-001'], quantity: 1, card: 'tok_ok', expect: (o) => o?.status === 'CONFIRMED' && o.completedAt },
    { label: 'paiement refusé', items: ['SKU-002'], quantity: 1, card: 'tok_declined', expect: (o) => o?.status === 'REJECTED' && o.rejectionReason === 'PAYMENT_DECLINED' },
    { label: 'stock insuffisant', items: ['SKU-LOW'], quantity: 51, card: 'tok_ok', expect: (o) => o?.status === 'REJECTED' && o.rejectionReason === 'INSUFFICIENT_STOCK' && o.paymentStatus === 'VOIDED' },
  ];
  for (const c of cases) {
    const { response, order } = await placeOrder({ customerId: `check-${Date.now()}`, ...c });
    line(Boolean(c.expect(order)), c.label, `HTTP ${response.status} → ${order ? `${order.status}${order.rejectionReason ? ` (${order.rejectionReason})` : ''}, paiement ${order.paymentStatus}` : 'aucune commande'}`);
  }
  say(`\n${failures ? `${failures} contrôle(s) en échec` : 'tout est en ordre'}`);
  process.exitCode = failures ? 1 : 0;
}

async function cmdLogs([service], opts) {
  const project = await requireActive();
  if (!service) throw new Error(`usage : ./poc logs <service> [--follow] [--tail N]  (services : ${SERVICES.join(', ')}, postgres${project === 'async' ? ', rabbitmq' : ''})`);
  await composeLive(project, ['logs', '--no-log-prefix', '--tail', String(opts.tail ?? 50), ...(opts.follow ? ['--follow'] : []), service]);
}

async function cmdConfig(_args, opts) {
  const project = await requireActive();
  const env = {
    TRACE_RATIO: opts.traces ?? '1.0',
    IDEMPOTENCY: opts.idempotency ?? 'on',
    ...(project === 'async' ? { DUPLICATE_DELIVERY: opts.duplicates ?? '1' } : {}),
  };
  if (opts.duplicates && project === 'sync') say('note : en sync, les doublons sont produits par k6 (S5), pas par les services ; --duplicates ignoré');
  say(`réglages : ${JSON.stringify(env)} (les options absentes reviennent à leur valeur par défaut)`);
  if (await composeLive(project, ['up', '-d', '--wait'], env)) throw new Error('recréation des services échouée');
  say('services recréés. ./poc up remet les réglages par défaut.');
}

async function cmdChaos([service], opts) {
  await requireActive();
  if (!SERVICES.includes(service) || (opts.latency === undefined && !opts.off)) throw new Error('usage : ./poc chaos <service> --latency <ms> | --off');
  const latencyMs = opts.off ? null : Number(opts.latency);
  const res = await http(`http://localhost:${SERVICE_PORTS[service]}/admin/chaos`, { method: 'POST', body: { latencyMs } });
  if (!res.ok) throw new Error(`chaos ${service} : HTTP ${res.status}`);
  say(`${service} : latence ${latencyMs === null ? 'normale' : `${latencyMs} ms`}`);
}

async function cmdFault([action, service]) {
  const project = await requireActive();
  if (!['stop', 'start'].includes(action) || !SERVICES.includes(service)) throw new Error('usage : ./poc fault stop|start <service>');
  await composeLive(project, [action, service]);
  say(`${service} ${action === 'stop' ? 'arrêté' : 'redémarré'}`);
}

async function cmdOrder(args, opts) {
  await requireActive();
  if (args[0] === 'get') {
    if (!args[1]) throw new Error('usage : ./poc order get <orderId>');
    const res = await http(`http://localhost:${SERVICE_PORTS.order}/orders/${args[1]}`);
    say(JSON.stringify(res.json ?? res, null, 2));
    return;
  }
  const items = (opts.sku ?? 'SKU-001').split(',').map((s) => s.trim());
  const { response, order } = await placeOrder({
    customerId: opts.customer ?? `cli-${Date.now()}`, items, quantity: Number(opts.qty ?? 1), card: opts.card ?? 'tok_ok', wait: !opts['no-wait'],
  });
  say(`HTTP ${response.status} ${JSON.stringify(response.json ?? response.error ?? response.text)}`);
  if (order) say(JSON.stringify(order, null, 2));
}

async function cmdTest() {
  const run = (cwd) => new Promise((res) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('npm', ['test', '--silent'], { cwd: join(ROOT, cwd), stdio: 'inherit' });
      child.on('close', (code) => res(code ?? 1));
    });
  });
  const results = {};
  for (const p of ['sync', 'async']) results[p] = await run(p);
  if (await activeProject()) results.common = await run('common');
  else say('\ncommon : sauté (ses tests ont besoin de PostgreSQL : ./poc up sync|async)');
  say(`\n${Object.entries(results).map(([p, c]) => `${ok(c === 0)} ${p}`).join('   ')}`);
  process.exitCode = Object.values(results).some((c) => c !== 0) ? 1 : 0;
}

// ------------------------------------------------------------------ relais vers common/scripts

const relay = (script) => async (args) => { process.exitCode = await runScript(script, args); };

async function cmdScenario(args) {
  // ./poc scenario s3 --project sync --rep 1 [...]  →  run-scenario.js --scenario s3 …
  const [scenario, ...rest] = args;
  if (!scenario) throw new Error('usage : ./poc scenario <s1|s2|s3|s4|s4b|s5> --project sync|async --rep <n> [--witness|--no-duplicates] [--tag <txt>]');
  process.exitCode = await runScript('run-scenario.js', ['--scenario', scenario, ...rest]);
}

async function cmdLoad(_args, opts) {
  // Charge libre, rangée en essai à blanc (jamais citée).
  const project = await requireActive();
  const runId = opts.run ?? `load-${project}-${Date.now()}`;
  const out = `results/dry-run/${project}/${runId}`;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(ROOT, out), { recursive: true });
  const { spawn } = await import('node:child_process');
  const k6 = 'grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8';
  const code = await new Promise((res) => {
    const child = spawn('docker', ['run', '--rm', '--network', 'poc-net',
      '-v', `${join(ROOT, 'common/benchmarks')}:/scripts:ro`, '-v', `${join(ROOT, 'results')}:/results`,
      '-e', 'K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write',
      '-e', 'K6_PROMETHEUS_RW_TREND_STATS=p(50),p(95),p(99),avg,max',
      k6, 'run', '-o', 'experimental-prometheus-rw', '--tag', `testid=${runId}`,
      '-e', `RUN_ID=${runId}`, '-e', `PROFILE=${opts.profile ?? 'constant'}`,
      '-e', `RATE=${opts.rate ?? 100}`, '-e', `DURATION=${opts.duration ?? '1m'}`,
      '--summary-export', `/results/dry-run/${project}/${runId}/k6-summary.json`, '/scripts/place-order.js'], { stdio: 'inherit' });
    child.on('close', (c) => res(c ?? 1));
  });
  if (code) throw new Error(`k6 a échoué (code ${code})`);
  say(`\nessai à blanc ${runId} → ${out}/ ; latences : ./poc latency --run ${runId}`);
}

// ------------------------------------------------------------------ aide et routage

const COMMANDS = {
  help: { run: cmdHelp, summary: 'cette aide' },
  build: { run: cmdBuild, usage: '[sync|async]', summary: 'construire l\'image des services' },
  up: { run: cmdUp, usage: 'sync|async [--build]', options: { build: { type: 'boolean' } }, summary: 'démarrer une variante (arrête l\'autre, démarre l\'observabilité si besoin)' },
  down: { run: cmdDown, usage: '[--obs] [--volumes [--yes]]', options: { obs: { type: 'boolean' }, volumes: { type: 'boolean' }, yes: { type: 'boolean' } }, summary: 'arrêter les variantes ; --volumes EFFACE les bases' },
  status: { run: cmdStatus, summary: 'variante active, conteneurs, cibles Prometheus, réglages du run' },
  check: { run: cmdCheck, summary: 'santé, infrastructure, parité et trois commandes témoins' },
  logs: { run: cmdLogs, usage: '<service> [--follow] [--tail N]', options: { follow: { type: 'boolean' }, tail: { type: 'string' } }, summary: 'logs d\'un service' },
  config: { run: cmdConfig, usage: '[--traces 0.1] [--idempotency on|off] [--duplicates 2]', options: { traces: { type: 'string' }, idempotency: { type: 'string' }, duplicates: { type: 'string' } }, summary: 'changer les réglages du run (recrée les services)' },
  chaos: { run: cmdChaos, usage: '<service> --latency <ms> | --off', options: { latency: { type: 'string' }, off: { type: 'boolean' } }, summary: 'ralentir un service (S3) ou le rétablir' },
  fault: { run: cmdFault, usage: 'stop|start <service>', summary: 'arrêter ou redémarrer un service (S4, S4b)' },
  reset: { run: relay('reset.js'), summary: 'remettre la base à zéro et purger les files RabbitMQ' },
  order: { run: cmdOrder, usage: '[--sku SKU-001,SKU-003] [--qty 2] [--card tok_ok|tok_declined] [--no-wait] | get <orderId>', options: { sku: { type: 'string' }, qty: { type: 'string' }, card: { type: 'string' }, customer: { type: 'string' }, 'no-wait': { type: 'boolean' } }, summary: 'passer ou relire une commande' },
  test: { run: cmdTest, summary: 'tests de sync, async et common (common exige une variante démarrée)' },
  verify: { run: relay('verify-invariants.js'), raw: true, usage: '[--out <fichier>]', summary: 'vérifier les invariants I1 à I11' },
  latency: { run: relay('latency.js'), raw: true, usage: '--run <RUN_ID> [--phase measure] [--slice 10]', summary: 'latences et débit d\'un run, depuis la base' },
  traces: { run: relay('trace-completeness.js'), raw: true, usage: '--project sync|async --run <RUN_ID> [--phase measure]', summary: 'part de traces complètes (H5)' },
  parity: { run: relay('check-parity.js'), raw: true, summary: 'parité sync / async (domain.js et configuration)' },
  scenario: { run: cmdScenario, raw: true, usage: '<s1|s2|s3|s4|s4b|s5> --project sync|async --rep <n> [--witness|--no-duplicates] [--tag <txt>]', summary: 'un run complet selon le protocole (run-scenario.js)' },
  load: { run: cmdLoad, usage: '[--rate 100] [--duration 1m] [--profile constant|steps] [--run <id>]', options: { rate: { type: 'string' }, duration: { type: 'string' }, profile: { type: 'string' }, run: { type: 'string' } }, summary: 'charge k6 libre, rangée en essai à blanc' },
};

function cmdHelp() {
  say('POC « communication synchrone et asynchrone » — usage : ./poc <commande> [options]\n');
  for (const [name, c] of Object.entries(COMMANDS)) {
    say(`  ${`${name} ${c.usage ?? ''}`.trim()}`);
    say(`      ${c.summary}`);
  }
  say('\nInterfaces : Grafana http://localhost:3100 · Jaeger http://localhost:16686 · Prometheus http://localhost:9090 · RabbitMQ http://localhost:15672 (async)');
}

const [name, ...argv] = process.argv.slice(2);
const command = COMMANDS[name ?? 'help'];
try {
  if (!command) throw new Error(`commande inconnue : ${name} (./poc help)`);
  if (command.raw) {
    await command.run(argv);
  } else {
    const { values, positionals } = parseArgs({ args: argv, options: command.options ?? {}, allowPositionals: true });
    await command.run(positionals, values);
  }
} catch (err) {
  console.error(`erreur : ${err.message}`);
  process.exitCode = 2;
}

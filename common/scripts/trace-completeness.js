// H5 : part des commandes échantillonnées dont la trace est complète (docs/hypotheses-assumption.md).
// À lancer juste après le run (Jaeger ne garde que 5 000 traces, C-2).
//
//   node common/scripts/trace-completeness.js --project sync|async --run <RUN_ID> [--phase measure]
//        [--jaeger http://localhost:16686] [--out results/.../traces.json]
//
// Les traces des commandes du run sont lues dans Jaeger (racines « POST /orders » du service order,
// attribut order.id), puis comparées aux étapes attendues selon l'état final de la commande en base.
// Avec l'échantillonnage (PC3), seule une partie des commandes est tracée : la part de traces
// complètes se calcule sur celles-là. Code de sortie : 0 mesure faite, 2 mesure impossible.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { connect, describeError } from './db.js';
import { patterns } from './latency.js';

// Étapes attendues : « service:repère », le repère étant la route HTTP (http.route) en sync et
// le type d'événement traité (event.type) en async.
export const EXPECTED = {
  sync: {
    CONFIRMED: ['order:/orders', 'payment:/payments', 'inventory:/reservations', 'shipping:/shipments', 'notification:/notifications'],
    PAYMENT_DECLINED: ['order:/orders', 'payment:/payments', 'notification:/notifications'],
    INSUFFICIENT_STOCK: ['order:/orders', 'payment:/payments', 'inventory:/reservations', 'payment:/payments/void', 'notification:/notifications'],
  },
  async: {
    CONFIRMED: ['order:/orders', 'payment:OrderCreated', 'inventory:PaymentAuthorized', 'order:InventoryReserved',
      'shipping:OrderConfirmed', 'notification:ShipmentRequested', 'order:NotificationSent'],
    PAYMENT_DECLINED: ['order:/orders', 'payment:OrderCreated', 'order:PaymentDeclined', 'notification:OrderRejected'],
    INSUFFICIENT_STOCK: ['order:/orders', 'payment:OrderCreated', 'inventory:PaymentAuthorized', 'order:InventoryInsufficient',
      'payment:OrderRejected', 'notification:OrderRejected', 'order:PaymentVoided'],
  },
};

/** Repères présents dans une trace Jaeger : { service:route } et { service:event.type }. */
export function markersOf(trace) {
  const services = Object.fromEntries(Object.entries(trace.processes).map(([id, p]) => [id, p.serviceName]));
  const found = new Set();
  for (const span of trace.spans) {
    const tags = Object.fromEntries(span.tags.map((t) => [t.key, t.value]));
    const service = services[span.processID];
    if (tags['http.route'] && tags['span.kind'] === 'server') found.add(`${service}:${tags['http.route']}`);
    if (tags['event.type']) found.add(`${service}:${tags['event.type']}`);
  }
  return found;
}

/** Étapes manquantes d'une trace pour une commande dans un état final donné. */
export function missingSteps(project, outcome, markers) {
  return (EXPECTED[project][outcome] ?? []).filter((m) => !markers.has(m));
}

async function jaeger(base, path) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Jaeger : HTTP ${res.status} sur ${path}`);
  return (await res.json()).data ?? [];
}

/** Traces des commandes, par tranches de 10 s sur la fenêtre [from, to] (µs). */
async function fetchTraces(base, from, to) {
  const traces = new Map();
  const step = 10_000_000;
  for (let start = from; start < to; start += step) {
    const qs = new URLSearchParams({
      service: 'order', operation: 'POST /orders', start: String(start), end: String(Math.min(start + step, to)), limit: '5000',
    });
    for (const t of await jaeger(base, `/api/traces?${qs}`)) traces.set(t.traceID, t);
  }
  return [...traces.values()];
}

function orderIdOf(trace) {
  for (const span of trace.spans) {
    const tag = span.tags.find((t) => t.key === 'order.id');
    if (tag && span.operationName === 'POST /orders') return tag.value;
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: args } = parseArgs({
    options: {
      project: { type: 'string' }, run: { type: 'string' }, phase: { type: 'string' },
      jaeger: { type: 'string', default: process.env.JAEGER_URL ?? 'http://localhost:16686' },
      out: { type: 'string' },
    },
  });
  if (!['sync', 'async'].includes(args.project) || !args.run) {
    console.error('usage : node common/scripts/trace-completeness.js --project sync|async --run <RUN_ID> [--phase measure] [--out …]');
    process.exit(2);
  }
  let client;
  try {
    client = await connect();
    const phases = args.phase ? args.phase.split(',') : undefined;
    const { rows: orders } = await client.query(
      `SELECT id, CASE WHEN status = 'CONFIRMED' THEN 'CONFIRMED' ELSE rejection_reason END AS outcome,
              status IN ('CONFIRMED', 'REJECTED') AS final, received_at
         FROM orders WHERE customer_id LIKE ANY($1::text[])`, [patterns(args.run, phases)]);
    if (orders.length === 0) throw new Error(`aucune commande pour le run « ${args.run} »`);
    const byId = new Map(orders.map((o) => [o.id, o]));
    const times = orders.map((o) => o.received_at.getTime());
    const from = (Math.min(...times) - 5000) * 1000;
    const to = (Math.max(...times) + 60000) * 1000;

    const traces = await fetchTraces(args.jaeger, from, to);
    const checked = [];
    for (const t of traces) {
      const order = byId.get(orderIdOf(t));
      if (!order || !order.final) continue; // autre run, autre phase, ou commande non terminée
      const missing = missingSteps(args.project, order.outcome, markersOf(t));
      checked.push({ orderId: order.id, outcome: order.outcome, traceId: t.traceID, complete: missing.length === 0, missing });
    }
    const complete = checked.filter((c) => c.complete).length;
    const ratio = checked.length ? complete / checked.length : null;
    const report = {
      project: args.project, runId: args.run, phases: phases ?? null,
      ordersInRun: orders.length, tracedOrders: checked.length, completeTraces: complete,
      completeRatio: ratio, sampledRatio: orders.length ? checked.length / orders.length : null,
      incomplete: checked.filter((c) => !c.complete).slice(0, 50),
    };
    console.log(`commandes du run : ${orders.length}   tracées (échantillon) : ${checked.length}   traces complètes : ${complete}`);
    if (ratio === null) {
      console.log('aucune trace trouvée : mesure inconclusive (Jaeger vidé ou commandes non échantillonnées ?)');
      process.exitCode = 2;
    } else {
      console.log(`part de traces complètes : ${(ratio * 100).toFixed(2)} %`);
      for (const c of report.incomplete.slice(0, 5)) console.log(`  incomplète ${c.orderId} (${c.outcome}) : manque ${c.missing.join(', ')}`);
    }
    if (args.out) {
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`rapport JSON : ${args.out}`);
    }
  } catch (err) {
    console.error(`mesure impossible : ${describeError(err)}`);
    process.exitCode = 2;
  } finally {
    await client?.end().catch(() => {});
  }
}

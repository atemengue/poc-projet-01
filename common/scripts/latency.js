// Latences et débit d'un run, calculés depuis la base (mêmes requêtes pour sync/ et async/,
// CLAUDE.md §6). Les commandes du run sont celles dont customer_id commence par « <RUN_ID>- ».
//
//   node common/scripts/latency.js --run <RUN_ID> [--slice <secondes>] [--out results/.../latency.json]
//
// --slice N : découpe aussi le run en tranches de N secondes (selon received_at), pour lire
// chaque palier d'une montée en charge séparément.
//
// Latences (en ms, depuis received_at = arrivée de la requête, cas C3) :
//   acceptation  = accepted_at  − received_at  (paiement autorisé ; critère p95 < 1 s)
//   confirmation = confirmed_at − received_at  (stock réservé, invariant satisfait)
//   complétion   = completed_at − received_at  (expédition + notification)
// Une commande sans l'horodatage d'une étape n'entre pas dans la latence de cette étape.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { connect, describeError } from './db.js';

const STAGES = [
  ['acceptance', 'accepted_at'],
  ['confirmation', 'confirmed_at'],
  ['completion', 'completed_at'],
];

const percentiles = (col) => `
  SELECT count(*)::int AS n,
         percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP
           (ORDER BY extract(epoch FROM ${col} - received_at) * 1000) AS p,
         max(extract(epoch FROM ${col} - received_at) * 1000) AS max
    FROM orders
   WHERE customer_id LIKE $1 AND ${col} IS NOT NULL`;

// Par tranche de `seconds` depuis la première commande : débit reçu et accepté, latence
// d'acceptation et de complétion, commandes restées non terminées (RECEIVED / ACCEPTED).
const SLICES = `
  WITH t AS (
    SELECT floor(extract(epoch FROM received_at - min(received_at) OVER ()) / $2)::int * $2 AS start_s,
           status, accepted_at, completed_at, received_at
      FROM orders WHERE customer_id LIKE $1)
  SELECT start_s,
         count(*)::int AS received,
         count(*) FILTER (WHERE accepted_at IS NOT NULL)::int AS accepted,
         count(*) FILTER (WHERE status IN ('RECEIVED', 'ACCEPTED'))::int AS unfinished,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM accepted_at - received_at) * 1000)
           FILTER (WHERE accepted_at IS NOT NULL) AS acceptance_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM accepted_at - received_at) * 1000)
           FILTER (WHERE accepted_at IS NOT NULL) AS acceptance_p99,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - received_at) * 1000)
           FILTER (WHERE completed_at IS NOT NULL) AS completion_p95
    FROM t GROUP BY start_s ORDER BY start_s`;

export async function measureSlices(client, runId, seconds) {
  const { rows } = await client.query(SLICES, [`${runId}-%`, seconds]);
  return rows.map((r) => ({
    startS: r.start_s,
    receivedPerSecond: r.received / seconds,
    acceptedPerSecond: r.accepted / seconds,
    unfinished: r.unfinished,
    acceptanceP95: r.acceptance_p95,
    acceptanceP99: r.acceptance_p99,
    completionP95: r.completion_p95,
  }));
}

export async function measure(client, runId) {
  const pattern = `${runId}-%`;

  const { rows: byStatus } = await client.query(
    `SELECT status, coalesce(rejection_reason, '') AS reason, count(*)::int AS n
       FROM orders WHERE customer_id LIKE $1 GROUP BY 1, 2 ORDER BY 1, 2`, [pattern]);

  const { rows: [window] } = await client.query(
    `SELECT count(*)::int AS total, min(received_at) AS first, max(received_at) AS last,
            extract(epoch FROM max(received_at) - min(received_at)) AS seconds,
            count(*) FILTER (WHERE accepted_at IS NOT NULL)::int AS accepted
       FROM orders WHERE customer_id LIKE $1`, [pattern]);

  const latency = {};
  for (const [stage, col] of STAGES) {
    const { rows: [r] } = await client.query(percentiles(col), [pattern]);
    const [p50, p95, p99] = r.p ?? [null, null, null];
    latency[stage] = { n: r.n, p50, p95, p99, max: r.max === null ? null : Number(r.max) };
  }

  const seconds = Number(window.seconds) || 0;
  return {
    runId,
    total: window.total,
    firstReceivedAt: window.first,
    lastReceivedAt: window.last,
    receivedPerSecond: seconds > 0 ? window.total / seconds : null,
    acceptedPerSecond: seconds > 0 ? window.accepted / seconds : null,
    byStatus,
    latency,
  };
}

const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`.padStart(8));
const rate = (v) => (v === null ? '—' : `${v.toFixed(1)} cmd/s`);

function print(m) {
  console.log(`run ${m.runId} : ${m.total} commande(s), reçues de ${m.firstReceivedAt?.toISOString?.() ?? '—'} à ${m.lastReceivedAt?.toISOString?.() ?? '—'}`);
  console.log(`débit reçu : ${rate(m.receivedPerSecond)}   débit accepté : ${rate(m.acceptedPerSecond)}\n`);
  console.log('statuts :');
  for (const s of m.byStatus) console.log(`  ${s.status.padEnd(10)} ${s.reason.padEnd(20)} ${s.n}`);
  console.log('\nlatences (depuis received_at) :');
  console.log(`  ${'étape'.padEnd(13)} ${'n'.padStart(6)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}`);
  for (const [stage, l] of Object.entries(m.latency)) {
    console.log(`  ${stage.padEnd(13)} ${String(l.n).padStart(6)} ${ms(l.p50)} ${ms(l.p95)} ${ms(l.p99)} ${ms(l.max)}`);
  }
  if (m.slices) {
    console.log(`\npar tranche de ${m.sliceSeconds} s (depuis la première commande ; la dernière tranche peut être partielle) :`);
    console.log(`  ${'début'.padStart(6)} ${'reçu/s'.padStart(7)} ${'accepté/s'.padStart(10)} ${'non fini'.padStart(9)} ${'acc p95'.padStart(8)} ${'acc p99'.padStart(8)} ${'compl p95'.padStart(9)}`);
    for (const t of m.slices) {
      console.log(`  ${`${t.startS} s`.padStart(6)} ${t.receivedPerSecond.toFixed(1).padStart(7)} ${t.acceptedPerSecond.toFixed(1).padStart(10)} ${String(t.unfinished).padStart(9)} ${ms(t.acceptanceP95)} ${ms(t.acceptanceP99)} ${ms(t.completionP95).padStart(9)}`);
    }
  }
  const p95 = m.latency.acceptance.p95;
  if (p95 !== null) console.log(`\ncritère p95 d'acceptation < 1 s : ${p95 < 1000 ? 'respecté' : 'NON respecté'} (${Math.round(p95)} ms)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: args } = parseArgs({ options: { run: { type: 'string' }, out: { type: 'string' }, slice: { type: 'string' } } });
  if (!args.run) {
    console.error('usage : node common/scripts/latency.js --run <RUN_ID> [--slice <secondes>] [--out <fichier.json>]');
    process.exit(2);
  }
  let client;
  try {
    client = await connect();
    const m = await measure(client, args.run);
    if (args.slice) {
      const seconds = Number(args.slice);
      if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('--slice attend un nombre entier de secondes');
      m.sliceSeconds = seconds;
      m.slices = await measureSlices(client, args.run, seconds);
    }
    if (m.total === 0) {
      console.error(`aucune commande pour le run « ${args.run} » : mesure inconclusive`);
      process.exitCode = 2;
    } else {
      print(m);
      if (args.out) {
        await mkdir(dirname(args.out), { recursive: true });
        await writeFile(args.out, `${JSON.stringify(m, null, 2)}\n`);
        console.log(`rapport JSON : ${args.out}`);
      }
    }
  } catch (err) {
    console.error(`mesure impossible : ${describeError(err)}`);
    process.exitCode = 2;
  } finally {
    await client?.end().catch(() => {});
  }
}

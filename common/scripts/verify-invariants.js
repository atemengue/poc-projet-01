// Vérifie les invariants I1 à I11 (docs/invariants.md) sur la base du POC.
// À lancer APRÈS drainage : sinon I10/I11 signalent des commandes encore en cours.
//
//   node common/scripts/verify-invariants.js [--out results/<projet>/<scénario>/rep-<n>/invariants.json]
//
// Code de sortie :
//   0  toutes les règles respectées
//   1  au moins une violation : c'est un RÉSULTAT à documenter, pas un run à jeter
//   2  vérification impossible ou sans objet (base injoignable, aucune commande) : verdict inconclusive
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { connect, describeError } from './db.js';
import { runChecks } from './invariants.js';

const SAMPLE = 5;
const FAMILY_LABEL = { safety: 'SÛRETÉ (ne doit jamais arriver)', liveness: 'VIVACITÉ (doit finir par arriver, après drainage)' };

function printReport({ ordersByStatus, totalOrders, results }, verdict) {
  const statuses = Object.entries(ordersByStatus).map(([s, n]) => `${s}=${n}`).join(', ') || 'aucune';
  console.log(`commandes : ${totalOrders} (${statuses})\n`);
  for (const family of ['safety', 'liveness']) {
    console.log(FAMILY_LABEL[family]);
    for (const r of results.filter((x) => x.family === family)) {
      const state = r.violations === 0 ? 'ok' : `VIOLÉE  ${r.violations} élément(s)`;
      console.log(`  ${r.id.padEnd(4)} ${r.title.padEnd(88)} ${state}`);
      for (const row of r.rows.slice(0, SAMPLE)) {
        const { key, ...detail } = row;
        const extra = Object.entries(detail).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`         - ${key}${extra ? `  ${extra}` : ''}`);
      }
      if (r.rows.length > SAMPLE) console.log(`         … ${r.rows.length - SAMPLE} ligne(s) de plus`);
    }
    console.log('');
  }
  const label = { ok: 'OK : toutes les règles sont respectées',
    violations: 'VIOLATIONS : résultat à documenter (le run reste valide)',
    inconclusive: 'INCONCLUSIVE : aucune commande, rien à vérifier' }[verdict];
  console.log(`verdict : ${label}`);
  console.log('rappel : I10 et I11 n\'ont de sens qu\'après drainage (plus aucune commande en cours).');
}

const { values: args } = parseArgs({ options: { out: { type: 'string' } } });

let client;
try {
  client = await connect();
  const report = await runChecks(client);
  const verdict = report.totalOrders === 0 ? 'inconclusive'
    : report.results.some((r) => r.violations > 0) ? 'violations' : 'ok';

  printReport(report, verdict);

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    const json = {
      checkedAt: new Date().toISOString(),
      verdict,
      totalOrders: report.totalOrders,
      ordersByStatus: report.ordersByStatus,
      results: report.results.map(({ rows, ...r }) => ({ ...r, sample: rows.slice(0, 50) })),
    };
    await writeFile(args.out, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`rapport JSON : ${args.out}`);
  }
  process.exitCode = { ok: 0, violations: 1, inconclusive: 2 }[verdict];
} catch (err) {
  console.error(`vérification impossible : ${describeError(err)}`);
  console.error('verdict : INCONCLUSIVE');
  process.exitCode = 2;
} finally {
  await client?.end().catch(() => {});
}

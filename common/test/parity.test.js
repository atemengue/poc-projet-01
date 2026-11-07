import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareDomains, compareConfig, firstDifference } from '../scripts/check-parity.js';

// Deux arborescences sync/ et async/ temporaires avec un domain.js par service.
async function trees(contents) {
  const root = await mkdtemp(join(tmpdir(), 'parity-'));
  for (const [project, files] of Object.entries(contents)) {
    for (const [service, text] of Object.entries(files)) {
      const dir = join(root, project, 'services', service);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'domain.js'), text);
    }
  }
  return root;
}

test('des domain.js identiques sont reconnus comme identiques', async () => {
  const root = await trees({ sync: { order: 'a\nb\n' }, async: { order: 'a\nb\n' } });
  const [r] = await compareDomains(join(root, 'sync'), join(root, 'async'), ['order']);
  assert.equal(r.identical, true);
  assert.equal(r.difference, null);
  await rm(root, { recursive: true });
});

test('une modification d\'un seul côté est détectée, avec sa ligne', async () => {
  const root = await trees({
    sync: { order: 'const LATENCY = 50;\nexport {};\n' },
    async: { order: 'const LATENCY = 40;\nexport {};\n' },
  });
  const [r] = await compareDomains(join(root, 'sync'), join(root, 'async'), ['order']);
  assert.equal(r.identical, false);
  assert.equal(r.difference.line, 1);
  assert.match(r.difference.async, /40/);
  await rm(root, { recursive: true });
});

test('un domain.js manquant rend le contrôle impossible (erreur)', async () => {
  const root = await trees({ sync: { order: 'x' }, async: {} });
  await assert.rejects(compareDomains(join(root, 'sync'), join(root, 'async'), ['order']), { code: 'ENOENT' });
  await rm(root, { recursive: true });
});

test('firstDifference signale une ligne ajoutée en fin de fichier', () => {
  assert.deepEqual(firstDifference('a', 'a\nb'), { line: 2, sync: '(fin du fichier)', async: 'b' });
});

const svc = (env, extra = {}) => ({ cpus: 1, mem_limit: '536870912', environment: env, ...extra });
const syncCfg = () => ({ services: { order: svc({ PG_POOL_MAX: '20', LOG_LEVEL: 'info', OUTBOUND_CONNECTIONS: '64' }) } });
const asyncCfg = () => ({ services: { order: svc({ PG_POOL_MAX: '20', LOG_LEVEL: 'info', PREFETCH: '64' }) } });

test('une configuration équitable passe tous les contrôles', () => {
  const checks = compareConfig(syncCfg(), asyncCfg(), ['order']);
  assert.ok(checks.length > 0);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
});

test('un écart de ressources, de pool ou de prefetch est détecté', () => {
  for (const mutate of [
    (c) => { c.services.order.cpus = 2; },
    (c) => { c.services.order.mem_limit = '1073741824'; },
    (c) => { c.services.order.environment.PG_POOL_MAX = '40'; },
    (c) => { c.services.order.environment.PREFETCH = '20'; },
    (c) => { c.services.order.environment.SIMULATED_LATENCY_MS = '0'; },
  ]) {
    const cfg = asyncCfg();
    mutate(cfg);
    const bad = compareConfig(syncCfg(), cfg, ['order']).filter((c) => !c.ok);
    assert.equal(bad.length, 1, mutate.toString());
  }
});

test('un service absent d\'un projet est signalé', () => {
  const bad = compareConfig(syncCfg(), { services: {} }, ['order']).filter((c) => !c.ok);
  assert.deepEqual(bad.map((c) => c.check), ['service présent']);
});

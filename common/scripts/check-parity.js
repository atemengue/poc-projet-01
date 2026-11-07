// Contrôle de parité entre sync/ et async/ (étape 5, CLAUDE.md §3 et §6).
//
// 1. Code métier : chaque services/<nom>/domain.js doit être identique dans les deux projets
//    (empreinte SHA-256). Une divergence voulue doit être documentée dans l'ADR.
// 2. Configuration (règle d'équité) : pour chaque service, mêmes cpus, mem_limit, PG_POOL_MAX,
//    LOG_LEVEL, SIMULATED_LATENCY_MS, taux d'échantillonnage des traces (PC3) et IDEMPOTENCY ; PREFETCH de chaque consommateur async/ égal à
//    OUTBOUND_CONNECTIONS d'Order dans sync/ (concurrence maximale reçue par un service, AS6).
//
//   node common/scripts/check-parity.js [--out results/.../parity.json]   (ou : cd common && npm run parity)
//
// Code de sortie : 0 parité respectée ; 1 au moins une divergence ; 2 contrôle impossible
// (fichier manquant, Docker indisponible).
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

export const SERVICES = ['order', 'payment', 'inventory', 'shipping', 'notification'];
const ROOT = resolve(new URL('../..', import.meta.url).pathname);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Première ligne qui diffère entre deux textes (numérotée à partir de 1), ou null. */
export function firstDifference(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) return { line: i + 1, sync: la[i] ?? '(fin du fichier)', async: lb[i] ?? '(fin du fichier)' };
  }
  return null;
}

/** Compare les domain.js. Lève une erreur si un fichier manque (contrôle impossible). */
export async function compareDomains(syncDir, asyncDir, services = SERVICES) {
  const results = [];
  for (const name of services) {
    const rel = join('services', name, 'domain.js');
    const [a, b] = await Promise.all([readFile(join(syncDir, rel), 'utf8'), readFile(join(asyncDir, rel), 'utf8')]);
    const same = sha256(a) === sha256(b);
    results.push({
      service: name,
      file: rel,
      syncSha256: sha256(a),
      asyncSha256: sha256(b),
      identical: same,
      difference: same ? null : firstDifference(a, b),
    });
  }
  return results;
}

/**
 * Compare la configuration des services, à partir de `docker compose config --format json`
 * de chaque projet. Retourne une liste de contrôles { check, service, sync, async, ok }.
 */
export function compareConfig(syncCfg, asyncCfg, services = SERVICES) {
  const checks = [];
  const env = (cfg, svc, key) => cfg.services?.[svc]?.environment?.[key] ?? null;
  const field = (cfg, svc, key) => {
    const v = cfg.services?.[svc]?.[key];
    return v === undefined || v === null ? null : String(v);
  };
  const add = (check, service, a, b) => checks.push({ check, service, sync: a, async: b, ok: a === b });

  for (const svc of services) {
    if (!syncCfg.services?.[svc] || !asyncCfg.services?.[svc]) {
      add('service présent', svc, syncCfg.services?.[svc] ? 'oui' : 'non', asyncCfg.services?.[svc] ? 'oui' : 'non');
      continue;
    }
    add('cpus', svc, field(syncCfg, svc, 'cpus'), field(asyncCfg, svc, 'cpus'));
    add('mem_limit', svc, field(syncCfg, svc, 'mem_limit'), field(asyncCfg, svc, 'mem_limit'));
    for (const key of ['PG_POOL_MAX', 'LOG_LEVEL', 'SIMULATED_LATENCY_MS', 'OTEL_TRACES_SAMPLER', 'OTEL_TRACES_SAMPLER_ARG', 'IDEMPOTENCY']) {
      add(key, svc, env(syncCfg, svc, key), env(asyncCfg, svc, key));
    }
    // AS6 : concurrence maximale reçue par un service.
    add('OUTBOUND_CONNECTIONS (sync, order) = PREFETCH (async)', svc,
      env(syncCfg, 'order', 'OUTBOUND_CONNECTIONS'), env(asyncCfg, svc, 'PREFETCH'));
  }
  return checks;
}

async function composeConfig(project) {
  const { stdout } = await promisify(execFile)(
    'docker', ['compose', '-f', join(ROOT, project, 'docker-compose.yml'), 'config', '--format', 'json'],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

const short = (h) => h.slice(0, 12);

function print(domains, config) {
  console.log('CODE MÉTIER (services/<nom>/domain.js)');
  for (const d of domains) {
    const state = d.identical ? 'identique' : 'DIFFÉRENT';
    console.log(`  ${d.service.padEnd(13)} sync ${short(d.syncSha256)}  async ${short(d.asyncSha256)}  ${state}`);
    if (d.difference) {
      console.log(`      première différence, ligne ${d.difference.line} :`);
      console.log(`        sync  : ${d.difference.sync}`);
      console.log(`        async : ${d.difference.async}`);
    }
  }
  console.log('\nCONFIGURATION (docker-compose.yml)');
  const bad = config.filter((c) => !c.ok);
  console.log(`  ${config.length - bad.length}/${config.length} contrôles identiques`);
  for (const c of bad) console.log(`  DIFFÉRENT  ${c.service.padEnd(13)} ${c.check} : sync=${c.sync} async=${c.async}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: args } = parseArgs({ options: { out: { type: 'string' } } });
  try {
    const domains = await compareDomains(join(ROOT, 'sync'), join(ROOT, 'async'));
    const config = compareConfig(await composeConfig('sync'), await composeConfig('async'));
    print(domains, config);

    const ok = domains.every((d) => d.identical) && config.every((c) => c.ok);
    console.log(`\nverdict : ${ok ? 'OK : parité respectée' : 'DIVERGENCE : à corriger, ou à documenter dans l\'ADR si elle est voulue'}`);
    if (args.out) {
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(args.out, `${JSON.stringify({ checkedAt: new Date().toISOString(), ok, domains, config }, null, 2)}\n`);
      console.log(`rapport JSON : ${args.out}`);
    }
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error(`contrôle impossible : ${err.code === 'ENOENT' ? `fichier manquant (${err.path ?? err.message})` : err.message}`);
    process.exitCode = 2;
  }
}

// Charge Place Order, identique pour sync/ et async/ (règle d'équité : même charge k6).
// Réponse attendue : 201 en sync/, 202 en async/ (D4).
// Modèle ouvert (arrival-rate) : k6 envoie le débit prévu quel que soit le temps de réponse ;
// un système saturé ne reçoit donc pas moins de requêtes (sinon la saturation serait masquée).
// Les itérations que k6 ne peut pas lancer faute de VU libre sont comptées dans
// dropped_iterations (run invalide au-delà de 1 %, CLAUDE.md §8).
//
// Variables :
//   TARGET          URL d'Order                          (défaut http://order:3000)
//   RUN_ID          préfixe des customerId               (obligatoire)
//   PROFILE         s1 | s2 | s3 | s4 | s4b | s5 : profils des scénarios (profiles.js, PC1)
//                   constant : RATE pendant DURATION ; steps : paliers STEPS (essais à blanc)
//   RATE, DURATION, STEPS                                (profils constant et steps)
//   CLIENT_TIMEOUT  délai maximal d'une requête          (défaut 5s, PC2)
//   MAX_VUS         plafond de VUs                       (défaut 3000, PC2)
//   DUPLICATE       2 : chaque commande est renvoyée une fois, après la première réponse, avec le
//                   même Idempotency-Key (S5 côté sync, PC5) ; 1 par défaut
//
// customerId = <RUN_ID>-<phase>-<n> pour les profils de scénario : latency.js retrouve les
// commandes d'une phase sans dépendre des horloges. Les métriques k6 sont étiquetées par phase.
//
// Mélange (D12) : 3 % paiement refusé, 2 % SKU-LOW, 95 % de 1 à 2 SKU parmi SKU-001..005.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { PROFILES, phaseAt, totalSeconds } from './profiles.js';

const TARGET = __ENV.TARGET || 'http://order:3000';
const RUN_ID = __ENV.RUN_ID;
if (!RUN_ID) throw new Error('RUN_ID est obligatoire (ex. -e RUN_ID=dry-sync-01)');
const PROFILE = __ENV.PROFILE || 'constant';
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '1m';
const STEPS = (__ENV.STEPS || '100,200,300,400,500').split(',').map(Number);
const CLIENT_TIMEOUT = __ENV.CLIENT_TIMEOUT || '5s';
const MAX_VUS = Number(__ENV.MAX_VUS || 3000);
const DUPLICATE = Number(__ENV.DUPLICATE || 1);

const scenarioProfile = PROFILES[PROFILE] ?? null;

// Requêtes abandonnées par le client au bout de CLIENT_TIMEOUT (PC2), par phase.
const clientTimeouts = new Counter('client_timeouts');

// R2' : VUs préparés d'avance = débit maximal × délai client. Créer des VUs pendant le run est
// lent : quand les requêtes s'allongent jusqu'au délai client, k6 perdait des itérations faute
// de VU prêt (essai sync S3, 411 itérations perdues, toutes dans la phase de panne).
const timeoutSeconds = Number.parseFloat(CLIENT_TIMEOUT) * (CLIENT_TIMEOUT.endsWith('ms') ? 0.001 : 1);
const vusFor = (peak) => Math.min(MAX_VUS, Math.max(50, Math.ceil(peak * timeoutSeconds)));

function placeOrderScenario() {
  if (scenarioProfile) {
    const { phases } = scenarioProfile;
    const peak = Math.max(...phases.map((p) => p.rate));
    return {
      executor: 'ramping-arrival-rate',
      startRate: phases[0].rate,
      timeUnit: '1s',
      preAllocatedVUs: vusFor(peak),
      maxVUs: MAX_VUS,
      // Chaque phase : 1 s de transition vers son débit, puis maintien.
      stages: phases.flatMap((p) => [
        { target: p.rate, duration: '1s' },
        { target: p.rate, duration: `${p.seconds - 1}s` },
      ]),
    };
  }
  if (PROFILE === 'constant') {
    return {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(RATE),
      maxVUs: MAX_VUS,
    };
  }
  if (PROFILE === 'steps') {
    return {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: vusFor(Math.max(...STEPS)),
      maxVUs: MAX_VUS,
      stages: [
        { target: 50, duration: '30s' },
        ...STEPS.flatMap((rate) => [{ target: rate, duration: '5s' }, { target: rate, duration: '55s' }]),
      ],
    };
  }
  throw new Error(`PROFILE inconnu : ${PROFILE} (s1, s2, s3, s4, s4b, s5, constant ou steps)`);
}

const scenarios = { place_order: { ...placeOrderScenario(), exec: 'placeOrder' } };
if (scenarioProfile?.probe) {
  // S3 : sonde GET /orders/:id une fois par seconde pendant tout le run.
  scenarios.probe = {
    executor: 'constant-arrival-rate',
    rate: 1,
    timeUnit: '1s',
    duration: `${totalSeconds(scenarioProfile)}s`,
    preAllocatedVUs: 5,
    maxVUs: 20,
    exec: 'probe',
  };
}

// Seuils toujours vrais : ils obligent k6 à exporter les mesures par phase dans le résumé
// (--summary-export), que run-scenario.js relit.
const thresholds = {};
for (const p of scenarioProfile?.phases ?? []) {
  thresholds[`http_req_duration{name:POST /orders,phase:${p.name}}`] = ['max>=0'];
  thresholds[`http_reqs{name:POST /orders,phase:${p.name}}`] = ['count>=0'];
  thresholds[`client_timeouts{phase:${p.name}}`] = ['count>=0'];
  if (scenarioProfile.probe) thresholds[`http_req_duration{name:GET /orders/:id,phase:${p.name}}`] = ['max>=0'];
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

const SKUS = ['SKU-001', 'SKU-002', 'SKU-003', 'SKU-004', 'SKU-005'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function buildOrder(customerId) {
  const draw = Math.random();
  let items;
  let quantity;
  let cardToken = 'tok_ok';
  if (draw < 0.03) {
    cardToken = 'tok_declined';
    items = [pick(SKUS)];
    quantity = 1;
  } else if (draw < 0.05) {
    items = ['SKU-LOW'];
    quantity = 1;
  } else {
    const first = pick(SKUS);
    items = between(1, 2) === 1 ? [first] : [first, pick(SKUS.filter((s) => s !== first))];
    quantity = between(1, 3);
  }
  return {
    customerId,
    items,
    quantity,
    paymentInformation: { cardToken },
    shippingAddress: { line1: '1 rue X', city: 'Montreal' },
  };
}

function currentPhase() {
  if (!scenarioProfile) return 'run';
  return phaseAt(scenarioProfile, (Date.now() - exec.scenario.startTime) / 1000);
}

function post(body, phase, idempotencyKey) {
  const headers = { 'content-type': 'application/json' };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = http.post(`${TARGET}/orders`, body, {
    headers,
    timeout: CLIENT_TIMEOUT,
    tags: { name: 'POST /orders', phase },
  });
  // Abandon côté client : pas de réponse dans le délai (k6 : statut 0, erreur 1050).
  if (res.status === 0 && res.error_code === 1050) clientTimeouts.add(1, { phase });
  // sync/ répond 201 (workflow terminé), async/ répond 202 (commande reçue, D4).
  check(res, { 'status 201 (sync) ou 202 (async)': (r) => r.status === 201 || r.status === 202 }, { phase });
  return res;
}

// Commande créée avant le run, lue par la sonde de S3.
export function setup() {
  if (!scenarioProfile?.probe) return {};
  const res = http.post(`${TARGET}/orders`, JSON.stringify(buildOrder(`${RUN_ID}-probe-0`)), {
    headers: { 'content-type': 'application/json' },
    timeout: CLIENT_TIMEOUT,
  });
  return { probeOrderId: res.json('orderId') };
}

export function placeOrder() {
  const phase = currentPhase();
  const customerId = scenarioProfile
    ? `${RUN_ID}-${phase}-${exec.scenario.iterationInTest}`
    : `${RUN_ID}-${exec.scenario.iterationInTest}`;
  const body = JSON.stringify(buildOrder(customerId));
  // S5 côté sync (PC5) : même requête renvoyée après la première réponse, même Idempotency-Key.
  const key = DUPLICATE > 1 ? customerId : undefined;
  for (let i = 0; i < DUPLICATE; i += 1) post(body, phase, key);
}

export function probe(data) {
  if (!data.probeOrderId) return;
  http.get(`${TARGET}/orders/${data.probeOrderId}`, {
    timeout: CLIENT_TIMEOUT,
    tags: { name: 'GET /orders/:id', phase: currentPhase() },
  });
}

// Compatibilité : `k6 run` sans scénario explicite appelle la fonction par défaut.
export default placeOrder;

// Charge Place Order, identique pour sync/ et async/ (règle d'équité : même charge k6).
// Modèle ouvert (constant-arrival-rate) : k6 envoie RATE commandes/s quel que soit le temps
// de réponse ; un système saturé ne reçoit donc pas moins de requêtes (sinon la saturation
// serait masquée). Les itérations que k6 ne peut pas lancer faute de VU libre sont comptées
// dans dropped_iterations (run invalide au-delà de 1 %, CLAUDE.md §8).
//
// Variables :
//   TARGET    URL d'Order               (défaut http://order:3000)
//   RATE      commandes par seconde      (défaut 100)
//   DURATION  durée                      (défaut 1m)
//   RUN_ID    préfixe des customerId     (obligatoire : sert à retrouver les commandes en base)
//
// Mélange (D12) : 3 % paiement refusé, 2 % SKU-LOW, 95 % de 1 à 2 SKU parmi SKU-001..005.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const TARGET = __ENV.TARGET || 'http://order:3000';
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '1m';
const RUN_ID = __ENV.RUN_ID;
if (!RUN_ID) throw new Error('RUN_ID est obligatoire (ex. -e RUN_ID=dry-sync-01)');

export const options = {
  scenarios: {
    place_order: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, RATE * 2),
      maxVUs: Math.max(200, RATE * 10),
    },
  },
  // Un statut 400/502 n'est pas un échec réseau ; on le suit par le check ci-dessous.
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

export default function () {
  const customerId = `${RUN_ID}-${exec.scenario.iterationInTest}`;
  const res = http.post(`${TARGET}/orders`, JSON.stringify(buildOrder(customerId)), {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'POST /orders' },
  });
  check(res, { 'status 201': (r) => r.status === 201 });
}

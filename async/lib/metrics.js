import client from 'prom-client';

// Métriques par défaut de Node (CPU, mémoire, retard de la boucle d'événements…), plus les
// métriques de l'étape 7 retenues parce qu'elles servent une hypothèse (PC4,
// docs/decisions-conception.md). Les latences se calculent en base, pas ici.
export const register = new client.Registry();
register.setDefaultLabels({ service: process.env.OTEL_SERVICE_NAME });
client.collectDefaultMetrics({ register });

// H1, H3c : requêtes HTTP en cours de traitement (où l'attente s'accumule côté serveur).
export const inflightRequests = new client.Gauge({
  name: 'inflight_requests',
  help: 'Requêtes HTTP en cours de traitement (hors /health, /metrics, /admin)',
  registers: [register],
});

// H4 : doublons reconnus et écartés par la protection d'idempotence.
export const duplicatesDetected = new client.Counter({
  name: 'duplicates_detected_total',
  help: 'Doublons détectés et ignorés (événement déjà traité, ou requête au même Idempotency-Key)',
  registers: [register],
});

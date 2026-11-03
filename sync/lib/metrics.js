import client from 'prom-client';

// Métriques par défaut de Node (CPU, mémoire, retard de la boucle d'événements…).
// Les métriques de l'étape 7 (order_stage_duration_seconds, inflight_requests…) viendront ici.
export const register = new client.Registry();
register.setDefaultLabels({ service: process.env.OTEL_SERVICE_NAME });
client.collectDefaultMetrics({ register });

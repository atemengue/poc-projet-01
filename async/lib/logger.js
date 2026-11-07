import pino from 'pino';

// Logs JSON ; traceId/spanId sont ajoutés par l'instrumentation OTel de pino,
// orderId est passé par l'appelant (log.info({ orderId }, '...')).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.OTEL_SERVICE_NAME },
});

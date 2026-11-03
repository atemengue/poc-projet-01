// Chargé avant l'application : node --import ./lib/telemetry.js services/<nom>/server.js
// Configuration par variables d'environnement standard : OTEL_SERVICE_NAME,
// OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SDK_DISABLED=true pour couper.
import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  // Les modules importés en ESM (dont pg) ne sont instrumentables qu'avec ce hook.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // traceId/spanId ajoutés à chaque log pino ; pas d'envoi des logs par OTLP.
        '@opentelemetry/instrumentation-pino': {
          disableLogSending: true,
          logKeys: { traceId: 'traceId', spanId: 'spanId', traceFlags: 'traceFlags' },
        },
      }),
    ],
  });
  sdk.start();

  // Vide les spans en attente quand le serveur s'est arrêté proprement.
  let flushed = false;
  process.on('beforeExit', () => {
    if (flushed) return;
    flushed = true;
    sdk.shutdown().catch(() => {});
  });
}

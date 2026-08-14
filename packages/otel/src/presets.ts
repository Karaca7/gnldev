// Named observability presets — a "one-line integration" for common OTEL providers.
// Each preset turns the provider's DOCUMENTED OTLP/HTTP endpoint + auth headers into a ready-made
// `ExportRunToOtlpOptions`; the user just calls `exportRunToOtlp(reader, runId, preset)`, done.
// GNL never sends to an endpoint on its own — a preset only produces CONFIGURATION (pure functions).
// Endpoint addresses are the defaults from the provider's documentation; every preset has an `endpoint` override.
import type { ExportRunToOtlpOptions } from './otlp.js';

type Overrides = Partial<Pick<ExportRunToOtlpOptions, 'endpoint' | 'serviceName' | 'resourceAttributes'>>;

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** Langfuse (cloud eu/us or self-hosted `baseUrl`): Basic auth = publicKey:secretKey. */
export function langfuse(opts: {
  publicKey: string;
  secretKey: string;
  /** 'eu' (default) | 'us' — cloud region. Ignored if `baseUrl` is given. */
  region?: 'eu' | 'us';
  /** Base URL for self-hosted (e.g. 'https://langfuse.acme.internal'). */
  baseUrl?: string;
} & Overrides): ExportRunToOtlpOptions {
  const base = opts.baseUrl ?? (opts.region === 'us' ? 'https://us.cloud.langfuse.com' : 'https://cloud.langfuse.com');
  return {
    endpoint: opts.endpoint ?? `${base}/api/public/otel/v1/traces`,
    headers: { authorization: `Basic ${b64(`${opts.publicKey}:${opts.secretKey}`)}` },
    serviceName: opts.serviceName,
    resourceAttributes: opts.resourceAttributes,
  };
}

/** Generic API-key-authenticated OTLP/HTTP endpoint: x-api-key (+ optional project name header).
 * `endpoint` is REQUIRED — unlike the other presets this has no hardcoded provider default, so it
 * Works with any OTLP/HTTP collector that authenticates via an `x-api-key`-style header. */
export function apiKeyOtlp(opts: { endpoint: string; apiKey: string; project?: string; projectHeader?: string } & Overrides): ExportRunToOtlpOptions {
  return {
    endpoint: opts.endpoint,
    headers: { 'x-api-key': opts.apiKey, ...(opts.project ? { [opts.projectHeader ?? 'x-project']: opts.project } : {}) },
    serviceName: opts.serviceName,
    resourceAttributes: opts.resourceAttributes,
  };
}

/** Braintrust: Bearer + x-bt-parent (project). */
export function braintrust(opts: { apiKey: string; project: string } & Overrides): ExportRunToOtlpOptions {
  return {
    endpoint: opts.endpoint ?? 'https://api.braintrust.dev/otel/v1/traces',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'x-bt-parent': `project_name:${opts.project}` },
    serviceName: opts.serviceName,
    resourceAttributes: opts.resourceAttributes,
  };
}

/** Honeycomb: x-honeycomb-team (+ optional dataset — for classic accounts). */
export function honeycomb(opts: { apiKey: string; dataset?: string } & Overrides): ExportRunToOtlpOptions {
  return {
    endpoint: opts.endpoint ?? 'https://api.honeycomb.io/v1/traces',
    headers: { 'x-honeycomb-team': opts.apiKey, ...(opts.dataset ? { 'x-honeycomb-dataset': opts.dataset } : {}) },
    serviceName: opts.serviceName,
    resourceAttributes: opts.resourceAttributes,
  };
}

/** Datadog: via the local Datadog Agent's OTLP receiver (OTLP ingest must be enabled on the Agent). */
export function datadogAgent(opts: { host?: string; port?: number } & Overrides = {}): ExportRunToOtlpOptions {
  const host = opts.host ?? 'localhost';
  const port = opts.port ?? 4318;
  return {
    endpoint: opts.endpoint ?? `http://${host}:${port}/v1/traces`,
    serviceName: opts.serviceName,
    resourceAttributes: opts.resourceAttributes,
  };
}

/** Generic OTel Collector / Jaeger / Tempo: just give the base URL (`/v1/traces` is appended). */
export function collector(opts: { baseUrl: string; headers?: Record<string, string> } & Overrides): ExportRunToOtlpOptions {
  return {
    endpoint: opts.endpoint ?? `${opts.baseUrl.replace(/\/$/, '')}/v1/traces`,
    headers: opts.headers,
    serviceName: opts.serviceName,
    resourceAttributes: opts.resourceAttributes,
  };
}

/** All of them under one name: can also be used as `otlpPresets.langfuse({...})`. */
export const otlpPresets = { langfuse, apiKeyOtlp, braintrust, honeycomb, datadogAgent, collector } as const;

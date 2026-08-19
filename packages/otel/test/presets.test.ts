// otlpPresets — named observability integrations (pure configuration generators).
import { describe, it, expect } from 'vitest';
import { otlpPresets } from '../src/index.js';

describe('otlpPresets', () => {
  it('langfuse: region/self-hosted endpoints + Basic auth (publicKey:secretKey base64)', () => {
    const eu = otlpPresets.langfuse({ publicKey: 'pk', secretKey: 'sk' });
    expect(eu.endpoint).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
    expect(eu.headers!.authorization).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`);
    expect(otlpPresets.langfuse({ publicKey: 'p', secretKey: 's', region: 'us' }).endpoint).toContain('us.cloud.langfuse.com');
    expect(otlpPresets.langfuse({ publicKey: 'p', secretKey: 's', baseUrl: 'https://lf.acme.internal' }).endpoint)
      .toBe('https://lf.acme.internal/api/public/otel/v1/traces');
  });

  it('apiKeyOtlp/braintrust/honeycomb: auth headers under the correct keys', () => {
    const ak = otlpPresets.apiKeyOtlp({ endpoint: 'https://api.example.com/otel/v1/traces', apiKey: 'k', project: 'proj' });
    expect(ak.headers).toEqual({ 'x-api-key': 'k', 'x-project': 'proj' });
    const bt = otlpPresets.braintrust({ apiKey: 'k', project: 'p1' });
    expect(bt.headers).toEqual({ authorization: 'Bearer k', 'x-bt-parent': 'project_name:p1' });
    const hc = otlpPresets.honeycomb({ apiKey: 'k' });
    expect(hc.headers).toEqual({ 'x-honeycomb-team': 'k' });
  });

  it('apiKeyOtlp: has no built-in default endpoint (caller-supplied), and the project header name is overridable', () => {
    const ak = otlpPresets.apiKeyOtlp({ endpoint: 'http://ozel/v1/traces', apiKey: 'k', project: 'proj', projectHeader: 'x-custom-project' });
    expect(ak.endpoint).toBe('http://ozel/v1/traces');
    expect(ak.headers).toEqual({ 'x-api-key': 'k', 'x-custom-project': 'proj' });
  });

  it('datadogAgent defaults to localhost:4318; collector derives /v1/traces from the base URL', () => {
    expect(otlpPresets.datadogAgent().endpoint).toBe('http://localhost:4318/v1/traces');
    expect(otlpPresets.collector({ baseUrl: 'http://otel:4318/' }).endpoint).toBe('http://otel:4318/v1/traces');
  });

  it('endpoint override wins in every preset with a default; serviceName/resourceAttributes are carried over', () => {
    const p = otlpPresets.honeycomb({ apiKey: 'k', endpoint: 'http://ozel/v1/traces', serviceName: 'svc', resourceAttributes: { env: 'prod' } });
    expect(p.endpoint).toBe('http://ozel/v1/traces');
    expect(p.serviceName).toBe('svc');
    expect(p.resourceAttributes).toEqual({ env: 'prod' });
  });
});

// A base URL is joined through the URL parser, not by gluing two strings together.
//
// `${base}${path}` does not append when the base carries a query or a fragment — it SWALLOWS the path.
// Measured against langfuse's preset before the fix:
//
//   base 'https://lf.acme.internal#'    -> 'https://lf.acme.internal#/api/public/otel/v1/traces'
//   base 'https://lf.acme.internal?a=1' -> 'https://lf.acme.internal?a=1/api/public/otel/v1/traces'
//
// Both request path '/'. What travels on this wire is a run's whole trace — prompts, tool arguments,
// model output — under the exporter's credentials, so sending it to a host's site root instead of its
// OTLP receiver is not a 404 to shrug at. A trailing slash was the same bug in a milder form:
// '//api/...', which plenty of servers do not route.
describe('preset endpoints are built as URLs', () => {
  const lf = (baseUrl: string) => otlpPresets.langfuse({ publicKey: 'p', secretKey: 's', baseUrl });

  it('appends the path to a plain base', () => {
    expect(lf('https://lf.acme.internal').endpoint).toBe('https://lf.acme.internal/api/public/otel/v1/traces');
  });

  it('does not double the slash when the base ends with one', () => {
    expect(lf('https://lf.acme.internal/').endpoint).toBe('https://lf.acme.internal/api/public/otel/v1/traces');
  });

  it('keeps a base that already has a path', () => {
    expect(lf('https://lf.acme.internal/otel').endpoint)
      .toBe('https://lf.acme.internal/otel/api/public/otel/v1/traces');
  });

  it('refuses a base with a fragment rather than posting the trace to /', () => {
    // Rejected, not stripped: a base with a fragment was not meant to have a path appended, and
    // guessing which half the author intended is how the wrong endpoint gets configured quietly.
    expect(() => lf('https://lf.acme.internal#frag')).toThrow(/fragment/);
  });

  it('refuses a base with a query string for the same reason', () => {
    expect(() => lf('https://lf.acme.internal?a=1')).toThrow(/query string/);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => lf('lf.acme.internal')).toThrow(/not a valid base URL/);
  });

  it('applies to the collector and agent presets too, not just langfuse', () => {
    // The point of one helper: the next preset that takes a base cannot forget.
    expect(otlpPresets.collector({ baseUrl: 'http://tempo:4318/' }).endpoint).toBe('http://tempo:4318/v1/traces');
    expect(otlpPresets.datadogAgent({}).endpoint).toBe('http://localhost:4318/v1/traces');
    expect(() => otlpPresets.collector({ baseUrl: 'http://tempo:4318?x=1' })).toThrow(/query string/);
  });

  it('leaves an explicit endpoint completely alone', () => {
    // The override exists so a caller can point at something this package has never heard of; it must
    // not be re-derived or validated into a shape the preset prefers.
    expect(otlpPresets.collector({ baseUrl: 'http://ignored', endpoint: 'http://y/custom' }).endpoint)
      .toBe('http://y/custom');
  });
});

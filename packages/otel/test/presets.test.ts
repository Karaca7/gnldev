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

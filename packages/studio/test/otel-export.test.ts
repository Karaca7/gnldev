// OTEL export trigger: POST /runs/:id/otel-export. SECURITY DESIGN: Studio itself NEVER receives
// the target endpoint/API key — the host applies `opts.otelExport(runId)` with its own configured
// target (@gnldev/otel exportRunToOtlp runs in-host with its own preset); the server only TRIGGERS it.
// SAME pattern as cache-endpoints.test.ts: capability flag + permission (write) + audit + 501/no-op.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

const post = (app: any, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('capabilities.otelExport', () => {
  it('true only if the host gives opts.otelExport', async () => {
    const withFn = createStudioApi({ reader: new InMemoryJournal(), otelExport: async () => ({ ok: true, target: 'x' }) });
    expect((await (await call(withFn, '/capabilities')).json()).otelExport).toBe(true);

    const without = createStudioApi({ reader: new InMemoryJournal() });
    expect((await (await call(without, '/capabilities')).json()).otelExport).toBe(false);
  });
});

describe('POST /runs/:id/otel-export', () => {
  it('calls opts.otelExport(runId), returns the result as-is, run.otel-export lands in audit', async () => {
    const calls: string[] = [];
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      otelExport: async (runId) => {
        calls.push(runId);
        return { ok: true, target: 'https://cloud.langfuse.com' };
      },
    });
    const res = await post(app, '/runs/run-1/otel-export', {}, { 'x-gnl-actor': 'ops@acme.co' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, target: 'https://cloud.langfuse.com' });
    expect(calls).toEqual(['run-1']);

    const audit = await (await call(app, '/audit?action=run.otel-export')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({
      actor: 'ops@acme.co',
      target: 'run-1',
      detail: { ok: true, target: 'https://cloud.langfuse.com' },
    });
  });

  it('if the host function returns ok:false (an error), it is still relayed as-is with 200 + lands in audit', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      otelExport: async () => ({ ok: false, error: 'endpoint returned 500' }),
    });
    const res = await post(app, '/runs/run-1/otel-export');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: 'endpoint returned 500' });

    const audit = await (await call(app, '/audit?action=run.otel-export')).json();
    expect(audit.items[0]).toMatchObject({ target: 'run-1', detail: { ok: false, error: 'endpoint returned 500' } });
  });

  it('403 without write permission (otelExport is never called)', async () => {
    let called = false;
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      otelExport: async () => { called = true; return { ok: true }; },
      auth: { write: () => false },
    });
    const res = await post(app, '/runs/run-1/otel-export');
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });

  it('501 if opts.otelExport is not given (feature check comes AFTER the write permission check)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await post(app, '/runs/run-1/otel-export');
    expect(res.status).toBe(501);
  });
});

// 0.7.0 release panel D-8: `POST /workflows/:name/run` with `resume` and a run id that does not exist
// answered 400 with an internal error ("Cannot destructure property 'input' of 'undefined'") and left a
// "completed" run owned by the caller in the listing. A resume needs a run: a missing one is a 404 and
// nothing is written. For a caller who is not staff a foreign run answers the same 404 (ADR-0001: a
// non-staff caller sees a foreign run as missing), as `/agents/:name/resume` already did.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { createRestApi } from '../src/index.js';
import { echo } from './conformance-registry.js';

const SECRET = 'x'.repeat(40);
const tok = (sub: string) => `Bearer ${signSubjectToken({ sub }, SECRET, { ttlSec: 600 })}`;

function world() {
  const storage = new InMemoryStorage();
  const config: any = {
    storage, memoryFactory: (s: any) => new BasicMemory(s.runs ?? s), agents: { a: { model: echo } },
    workflows: { w: workflow<any>().then(step('draft', async ({ input }: any) => `draft:${input?.s}`)).then(waitForResume<{ ok: boolean }>('approve')) },
  };
  const api = createRestApi(config, { auth: roleAuth({ admin: { token: 'STAFF', orgId: 'acme' }, endUsers: { secret: SECRET, orgId: 'acme' } }), org: {}, protectionsBanner: false } as never) as (r: Request) => Promise<Response>;
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await api(new Request(`http://x${path}`, { method, headers: { authorization: who, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: r.status, body: await r.text() };
  };
  const keysOf = async (id: string) => (await storage.runs.listKeys!('')).filter((k: string) => k.includes(id));
  return { call, keysOf };
}

describe('D-8: resuming a workflow run that is not there', () => {
  it('a missing run answers 404 and writes nothing', async () => {
    const { call, keysOf } = world();
    const r = await call(tok('u-mallory'), 'POST', '/workflows/w/run', { runId: 'wf-none', resume: { approve: { ok: true } } });
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('destructure');
    expect(await keysOf('wf-none')).toEqual([]);
    expect((await call(tok('u-mallory'), 'GET', '/runs')).body).not.toContain('wf-none');
  });

  it('sibling: a foreign run answers the same 404 to an end user, and is untouched', async () => {
    const { call, keysOf } = world();
    expect((await call(tok('u-ayse'), 'POST', '/workflows/w/run', { runId: 'wf-ayse', input: { s: 'AYSE-WF' } })).status).toBe(200);
    const before = await keysOf('wf-ayse');
    const foreign = await call(tok('u-mallory'), 'POST', '/workflows/w/run', { runId: 'wf-ayse', resume: { approve: { ok: true } } });
    const missing = await call(tok('u-mallory'), 'POST', '/workflows/w/run', { runId: 'wf-none', resume: { approve: { ok: true } } });
    expect(foreign.status).toBe(404);
    expect(foreign.body.replace('wf-ayse', 'X')).toBe(missing.body.replace('wf-none', 'X'));
    expect(await keysOf('wf-ayse')).toEqual(before);
  });

  it('sibling: staff resuming a missing run gets the same 404', async () => {
    const { call, keysOf } = world();
    const st = await call('Bearer STAFF', 'POST', '/workflows/w/run', { runId: 'wf-none', resume: { approve: { ok: true } } });
    expect(st.status).toBe(404);
    expect(await keysOf('wf-none')).toEqual([]);
  });

  it('sibling: a resume that names no run is a 400, not a fresh run', async () => {
    const { call } = world();
    const r = await call(tok('u-mallory'), 'POST', '/workflows/w/run', { resume: { approve: { ok: true } } });
    expect(r.status).toBe(400);
  });

  it('control: the owner resumes her own suspended run', async () => {
    const { call } = world();
    expect((await call(tok('u-ayse'), 'POST', '/workflows/w/run', { runId: 'wf-ayse', input: { s: 'AYSE-WF' } })).status).toBe(200);
    const r = await call(tok('u-ayse'), 'POST', '/workflows/w/run', { runId: 'wf-ayse', resume: { approve: { ok: true } } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).suspended).toBe(false);
  });
});

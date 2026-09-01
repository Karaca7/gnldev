// GET /scheduler/triggers: @gnldev/scheduler trigger introspection. Studio itself does NOT require a
// running Scheduler INSTANCE — if the journal supports writable + listKeys, it READS from the
// journal via @gnldev/scheduler's `listTriggers` helper (see src/server.ts). Here we write triggers
// to the journal with the real `scheduleWorkflow`/`pollScheduler` and verify they're read back
// end-to-end (instead of a mock like the cache/queue tests — @gnldev/scheduler is already a devDependency).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler } from '@gnldev/scheduler';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

describe('GET /scheduler/triggers', () => {
  it('reads triggers written to the journal (id, kind/value, nextRunAt, misfire, maxAttempts)', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'daily', name: 'wf-report', cron: '0 9 * * *', maxAttempts: 3 }, Date.UTC(2026, 0, 1, 0, 0));
    await scheduleWorkflow(j, { id: 'poll', name: 'wf-sync', every: 60_000, misfire: 'catchup' }, 0);

    const app = createStudioApi({ reader: j });
    const res = await call(app, '/scheduler/triggers');
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.map((t: any) => t.id)).toEqual(['daily', 'poll']); // alphabetical

    const daily = list.find((t: any) => t.id === 'daily');
    expect(daily).toMatchObject({ name: 'wf-report', kind: 'cron', value: '0 9 * * *', maxAttempts: 3, misfire: 'skip', status: 'pending' });

    const poll = list.find((t: any) => t.id === 'poll');
    expect(poll).toMatchObject({ name: 'wf-sync', kind: 'every', value: 60_000, misfire: 'catchup', nextRunAt: 60_000, status: 'pending' });
  });

  it('an empty list if there are no triggers (not 500)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await call(app, '/scheduler/triggers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns an empty list if the journal is not writable/listKeys (same pattern as queue/jobs)', async () => {
    const bareReader = { listRuns: async () => [], readRun: async () => undefined };
    const app = createStudioApi({ reader: bareReader as any });
    const res = await call(app, '/scheduler/triggers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('a failed trigger: lastError/lastErrorAt are reflected', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'f1', name: 'wf-fail', at: 0, maxAttempts: 1 }, 0);
    await pollScheduler(j, { runWorkflow: async () => { throw new Error('connection dropped'); } }, 0);

    const app = createStudioApi({ reader: j });
    const list = await (await call(app, '/scheduler/triggers')).json();
    expect(list[0]).toMatchObject({ id: 'f1', status: 'failed', attempts: 1 });
    expect(list[0].lastError).toMatch(/connection dropped/);
  });

  it('401 without read permission', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: { read: () => false } });
    const res = await call(app, '/scheduler/triggers');
    expect(res.status).toBe(401);
  });

  /**
   * TWO OF THESE FIELDS ARE NOT CONFIGURATION, and they are the same two the dead-letter list gates.
   *
   * `TriggerInfo.input` is the scheduled workflow's own argument, verbatim — per-customer whenever a
   * trigger is. `TriggerInfo.lastError` is `String(err?.message ?? err)` from the host's own workflow,
   * which ran ON that input, so it quotes it the way every validation library does. This route
   * requires `catalog:read`, whose own catalogue entry promises "no customer data", and the gate that
   * puts both behind `payloads:read` had NO test: removing it entirely left the suite green.
   */
  describe('the customer-data gate', () => {
    const PEOPLE: Record<string, string[]> = {
      // May see that a scheduled job failed; may not read what it was given or what it said.
      support: ['catalog:read'],
      everything: ['*:read'],
    };
    const rbac = (j: InMemoryJournal) => createStudioApi({
      reader: j,
      auth: {
        authenticate: (req: Request) => {
          const tok = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
          return PEOPLE[tok] ? { id: tok, roles: ['viewer'], permissions: PEOPLE[tok] } : null;
        },
        authorize: (p: { permissions?: string[] } | null, _r: Request, ctx: { permission?: string }) => {
          const need = ctx.permission ?? 'unknown:read';
          const ok = (p?.permissions ?? []).some((g) => (g === '*:read' ? need.endsWith(':read') : g === need));
          return ok ? { allow: true } : { allow: false as const, status: 403 as const, reason: `missing ${need}` };
        },
        capabilities: () => ({ rbac: true }),
      } as never,
    });
    /** A trigger carrying real customer data, that then fails ON it — the realistic pair. */
    const failedWithInput = async () => {
      const j = new InMemoryJournal();
      await scheduleWorkflow(j, {
        id: 'nightly-invoice', name: 'wf-invoice', at: 0, maxAttempts: 1,
        input: { customerEmail: 'jane@customer.example', ssn: '123-45-6789' },
      }, 0);
      await pollScheduler(j, {
        runWorkflow: async () => { throw new Error("ValidationError: ssn '123-45-6789' invalid"); },
      }, 0);
      return j;
    };
    const list = (app: unknown, who: string) =>
      call(app as never, '/scheduler/triggers', { headers: { authorization: `Bearer ${who}` } });

    it('withholds `input` and `lastError` from a caller without `payloads:read`', async () => {
      const app = rbac(await failedWithInput());
      const res = await list(app, 'support');

      // 200, not 403: the SCHEDULE is configuration and this grant may read it. Only what flows
      // through it is withheld.
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text, 'the scheduled workflow’s own argument reached a `catalog:read`-only caller').not.toContain('123-45-6789');
      expect(text, 'the customer’s address travelled in the input').not.toContain('jane@customer.example');
      const row = JSON.parse(text)[0];
      expect(row, 'the row went missing along with the two fields it may not carry')
        .toMatchObject({ id: 'nightly-invoice', status: 'failed', attempts: 1 });
      expect(row.input, 'the input survived the gate').toBeUndefined();
      expect(row.lastError, 'the handler’s error text survived the gate').toBeUndefined();
    });

    it('says the error was WITHHELD rather than leaving the field absent', async () => {
      // `input` gets no marker (nothing renders it, so its absence cannot be misread) and `lastError`
      // does: it is rendered under a failed trigger, where a missing one reads as "failed for no
      // stated reason" — a claim about the TRIGGER, when the truth is a fact about the VIEWER.
      const app = rbac(await failedWithInput());
      const row = (await (await list(app, 'support')).json())[0];

      expect(row.lastErrorRestricted, 'a failed trigger with no stated reason').toBe(true);
      expect('inputRestricted' in row, 'a marker was invented for a field nothing renders').toBe(false);
    });

    it('a PENDING trigger gets no `lastErrorRestricted` — it is a statement about the record', async () => {
      const j = new InMemoryJournal();
      await scheduleWorkflow(j, { id: 'p1', name: 'wf-ok', every: 60_000 }, 0);
      const row = (await (await list(rbac(j), 'support')).json())[0];

      expect(row.status).toBe('pending');
      expect('lastErrorRestricted' in row, 'a trigger that has never failed was said to have a hidden error').toBe(false);
    });

    it('and `*:read` still gets both — the surface is not simply switched off', async () => {
      // Without this, the assertions above are satisfied by never returning the two fields to anyone.
      const app = rbac(await failedWithInput());
      const row = (await (await list(app, 'everything')).json())[0];

      expect(row.input, '`*:read` lost access to something it could read before')
        .toEqual({ customerEmail: 'jane@customer.example', ssn: '123-45-6789' });
      expect(row.lastError).toMatch(/ValidationError/);
      expect(row.lastErrorRestricted).toBeUndefined();
    });

    it('the free tier is untouched — no provider means no permission model to fail', async () => {
      const app = createStudioApi({ reader: await failedWithInput() });
      const row = (await (await call(app, '/scheduler/triggers')).json())[0];
      expect(row.lastError).toMatch(/ValidationError/);
      expect(row.input).toBeTruthy();
    });
  });

  it('capabilities.scheduler: true for a writable + listKeys journal, false for a bare reader', async () => {
    const withJournal = createStudioApi({ reader: new InMemoryJournal() });
    const capsWith = await (await call(withJournal, '/capabilities')).json();
    expect(capsWith.scheduler).toBe(true);

    const bareReader = { listRuns: async () => [], readRun: async () => undefined };
    const withoutJournal = createStudioApi({ reader: bareReader as any });
    const capsWithout = await (await call(withoutJournal, '/capabilities')).json();
    expect(capsWithout.scheduler).toBe(false);
  });
});

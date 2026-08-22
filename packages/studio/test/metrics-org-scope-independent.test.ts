// `GET /metrics` answered 500 to every organization-scoped caller while the unscoped operator got 200.
//
// The bridge is correct and its own comment predicts this: `countRunsByStatus` is deliberately NOT
// bridged per-organization (`organization.ts`), so under an active org `scopedNow()` returns a view
// that genuinely lacks the method and the bridge resolves the call to `undefined`. The CALL SITE broke
// the contract by doing `.catch()` on the result before awaiting it — `undefined.catch` throws.
//
// WHY NOTHING CAUGHT IT, which is the part worth keeping: the guard is a SETUP-TIME `typeof` check
// against the bridge object, and the bridge always carries the method. Whether the call RESOLVES to a
// promise depends on the ALS scope at call time. So a unit test with an unscoped reader passes, and
// only an organization-scoped request fails. A guard checked against one object while the behaviour
// depends on another.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, withOrg } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    if (t === 'ops') return { roles: ['admin'], id: 'u-ops' }; // unscoped operator
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};
const AS = {
  acme: { authorization: 'Bearer acme' },
  globex: { authorization: 'Bearer globex' },
  ops: { authorization: 'Bearer ops' },
};

/** One run per organization, with different token counts so the numbers cannot be confused. */
async function seeded() {
  const j = new InMemoryJournal();
  const put = async (org: string, run: string, tokens: number) => {
    await j.put(`org:${org}:${run}:input`, { prompt: 'hi', at: 1 });
    await j.put(`org:${org}:${run}:model:0`, {
      content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', modelId: 'm', at: 2,
      usage: { inputTokens: { total: tokens }, outputTokens: { total: 0 } },
    });
    await j.put(`org:${org}:${run}:outcome`, { status: 'completed', at: 3 });
  };
  await put('acme', 'r-acme', 1453);
  await put('globex', 'r-globex', 2754);
  // MATERIALIZED COUNTERS, per organization. Without them `readMetricsSummary` returns `all:
  // undefined`, the whole fast-path block is skipped, and the defective line is never reached — the
  // response comes back `source: "scan"` and a reverted fix passes. Measured: an earlier version of
  // this fixture seeded only raw run keys and the regression test could not fail.
  for (const [org, tokens] of [['acme', 1453], ['globex', 2754]] as const) {
    await j.incrBy!(`org:${org}:__metrics__:all`, { runs: 1, tokens, costUsdMicros: 0 });
  }
  return j;
}

const mkApi = async () =>
  createStudioApi({ reader: await seeded(), auth: authProvider, org: {} } as never) as unknown as
    (r: Request) => Promise<Response>;

const metrics = async (api: (r: Request) => Promise<Response>, who: Record<string, string>) => {
  const res = await api(new Request('http://x/metrics', { headers: who }));
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
};

describe('GET /metrics for an organization-scoped caller', () => {
  // The precondition. Without a `countRunsByStatus` on the reader the bridge is never installed and
  // the whole defect is unreachable, so the test would pass having exercised nothing.
  it('the reader offers the aggregate that makes this reachable at all', async () => {
    expect(typeof (await seeded() as unknown as Record<string, unknown>).countRunsByStatus,
      'the fixture reader has no countRunsByStatus — the bridge is never installed and this suite is vacuous')
      .toBe('function');
  });

  it.each([['acme'], ['globex']] as const)('%s gets 200, not 500', async (org) => {
    const api = await mkApi();
    const { status } = await metrics(api, AS[org]);

    expect(status,
      'an organization-scoped caller got an error from the metrics endpoint. The bridge resolves '
      + '`countRunsByStatus` to undefined under an active org — deliberately — and the call site must '
      + 'tolerate that rather than calling `.catch` on a non-promise.')
      .toBe(200);
  });

  it('the unscoped operator still gets 200 — the case that always worked', async () => {
    const api = await mkApi();
    expect((await metrics(api, AS.ops)).status).toBe(200);
  });

  // The stat cards read `Runs 0 · Tokens 0` next to a run list showing one run. A 200 with zeroes is
  // the same defect wearing a different face, so the numbers are asserted, not just the status.
  it('and the numbers are that organization\'s own', async () => {
    const api = await mkApi();
    const acme = await metrics(api, AS.acme);
    const globex = await metrics(api, AS.globex);

    expect(acme.body?.total, 'acme sees no runs — the stat cards read zero next to a non-empty run list').toBe(1);
    expect(globex.body?.total).toBe(1);
    expect(acme.body?.tokens, 'acme\'s token count is not its own').toBe(1453);
    expect(globex.body?.tokens).toBe(2754);
    // `source` is the endpoint's own honesty field, naming which path produced the numbers. Under an
    // organization it must be the listRuns fallback, because the aggregate is deliberately unbridged.
    // `source` names which path produced the numbers. `materialized` means the fast-path block RAN —
    // which is the block containing the defect. If this ever reads `scan`, the fixture has stopped
    // reaching the code under test and the regression guard is vacuous again.
    expect(acme.body?.source, 'the fast path was skipped — this fixture no longer reaches the defect')
      .toBe('materialized');
    expect(JSON.stringify(acme.body), 'acme\'s metrics carry globex\'s token count').toContain('1453');
    expect(JSON.stringify(acme.body), 'acme\'s metrics carry globex\'s token count').not.toContain('2754');
    expect(JSON.stringify(globex.body), 'globex\'s metrics carry acme\'s token count').not.toContain('1453');
  });

  // The operator's view aggregates every organization, so it must NOT match either one alone —
  // otherwise "per-org numbers" could be satisfied by a single shared answer handed to everybody.
  it('while the operator sees more than any single organization', async () => {
    const api = await mkApi();
    const ops = await metrics(api, AS.ops);
    const acme = await metrics(api, AS.acme);

    expect(ops.body?.total, 'the operator view is scoped to one organization').toBe(2);
    expect(ops.body?.tokens, 'the operator total is not the sum of both organizations').toBe(1453 + 2754);
  });
});

/**
 * THE SIBLING GUARD — is `countRunsByStatus` the only capability that can vanish at call time?
 *
 * Studio's reader is an ALS-delegating bridge: each capability is installed after a SETUP-TIME
 * `typeof` check against the RAW reader, then delegates through `scopedNow()` at call time. So a call
 * site may treat any of them as always-present. That is safe only while every bridged method also
 * exists on the org-scoped view — and `countRunsByStatus` is deliberately absent from it.
 *
 * Measured across the whole bridged set against `withOrg(InMemoryJournal, 'acme')`: it is the ONLY
 * one missing. Every other bridge would delegate to a real method, so none can resolve to `undefined`
 * the way this one did. That is why there are no siblings — a fact, not a spot-check.
 *
 * Asserted so it stays a fact. The day `withOrg` stops bridging a second capability, this fails and
 * every call site that assumes always-present needs the same `Promise.resolve(...)` treatment.
 */
describe('the org-scoped view is missing exactly one bridged capability', () => {
  /** Exactly the set studio installs on its reader bridge (grepped from `typeof (rawReader as any).X`). */
  const BRIDGED = ['countRunsByStatus', 'deletePrefix', 'get', 'getCounters', 'getMany',
    'listKeys', 'listRunsPaged', 'put', 'putIfAbsent', 'listRuns', 'readRun', 'readRunStats',
    'incrBy', 'putIfMatch', 'applyBatch', 'listStaleRuns'] as const;

  it('and it is countRunsByStatus', () => {
    const base = new InMemoryJournal() as unknown as Record<string, unknown>;
    const scoped = withOrg(new InMemoryJournal(), 'acme') as unknown as Record<string, unknown>;

    const missing = BRIDGED.filter((m) => typeof base[m] === 'function' && typeof scoped[m] !== 'function');

    expect(BRIDGED.filter((m) => typeof base[m] === 'function').length,
      'the base journal offers almost none of these — the comparison is vacuous').toBeGreaterThan(10);
    expect(missing,
      'a SECOND bridged capability is absent from the org-scoped view. Every studio call site that '
      + 'checks `typeof rw.<method> === "function"` and then treats the result as a promise has the '
      + 'same defect as GET /metrics did — the check passes because the bridge carries the method, '
      + 'and the call resolves to undefined only under an active organization.')
      .toEqual(['countRunsByStatus']);
  });
});

// `scopeRefused` and the capability booleans are two hand-maintained lists that must agree.
//
// `scopeRefusedCaps` enumerates queue/queueManage/cache/cacheManage/knowledge/workflowManage/memory by
// hand, right next to a `c.json({...})` that computes each boolean by hand. Nothing makes the two
// derive from the same fact, which is the shape that has produced a defect in this file repeatedly.
//
// So this file does not check the list. It checks the PROPERTY the list is trying to express, and the
// property is derivable without enumerating anything:
//
//   scopeRefused === exactly the capabilities that are FALSE for an organization-scoped caller
//                    and TRUE for an unscoped operator, on the same deployment.
//
// That is the endpoint's own documented promise — "false for THIS caller's scope but would be true for
// an unscoped operator". Two callers, one config, one set difference. A seventh capability, or a
// changed reachability check, cannot drift past it.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'ops') return { roles: ['admin'], id: 'u-ops' }; // unscoped operator
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};

type Caps = Record<string, unknown> & { scopeRefused?: string[] };

async function capsFor(opts: object) {
  const api = createStudioApi({ reader: new InMemoryJournal(), auth: authProvider, org: {}, ...opts } as never) as unknown as
    (r: Request) => Promise<Response>;
  const read = async (token: string): Promise<Caps> => {
    const res = await api(new Request('http://x/capabilities', { headers: { authorization: `Bearer ${token}` } }));
    return await res.json() as Caps;
  };
  return { acme: await read('acme'), ops: await read('ops') };
}

/** The capabilities an operator has and an organization-scoped caller does not — the ground truth. */
const derivedRefusals = (acme: Caps, ops: Caps): string[] =>
  Object.keys(ops)
    .filter((k) => k !== 'scopeRefused' && ops[k] === true && acme[k] === false)
    .sort();

const claimedRefusals = (acme: Caps): string[] => [...new Set(acme.scopeRefused ?? [])].sort();

/** Host objects with no organization boundary, in the shapes a deployment actually has. */
const FULL = {
  queue: { listJobs: () => [], retry: () => 'j2' },
  cache: { stats: () => ({ hits: 0, misses: 0, hitRate: 0, size: 0 }), invalidate: () => 1 },
  vectors: { search: () => [] },
  workflowStore: { list: () => [], get: () => undefined, set: () => {}, delete: () => {} },
  memory: { listThreads: () => [], getMessages: () => [] },
};
/** Same objects, minus the OPTIONAL methods that gate the `*Manage` capabilities. */
const NO_MANAGE = {
  queue: { listJobs: () => [] },
  cache: { stats: () => ({ hits: 0, misses: 0, hitRate: 0, size: 0 }) },
};
/** Managed workflow EXECUTION reachable only through the host store — no `gnl.runWorkflow`. */
const MANAGED_EXEC = {
  workflowStore: { list: () => [], get: () => undefined, set: () => {}, delete: () => {} },
  compileWorkflow: () => ({ build: () => [], run: async () => ({}) }),
  gnl: { listAgents: () => [], run: async () => ({ text: 'x' }) },
};

describe('scopeRefused agrees with the booleans it describes', () => {
  it.each([
    ['every host object present', FULL],
    ['host objects without their manage methods', NO_MANAGE],
    ['managed workflow execution via the host store', MANAGED_EXEC],
    ['a queue only', { queue: FULL.queue }],
    ['a conversation store only', { memory: FULL.memory }],
  ])('%s', async (_label, opts) => {
    const { acme, ops } = await capsFor(opts);

    expect(claimedRefusals(acme),
      'scopeRefused disagrees with the booleans. It must be exactly the capabilities that are false for '
      + 'this organization and true for an unscoped operator — anything else either tells the UI a '
      + 'capability is scope-refused when an operator cannot use it either, or leaves a genuinely '
      + 'scope-refused capability out, which is the "not configured" defect this list exists to fix.')
      .toEqual(derivedRefusals(acme, ops));
  });

  // The two ends, which must both be empty for the list to mean anything at all.
  it('is empty for an unscoped operator', async () => {
    const { ops } = await capsFor(FULL);
    expect(ops.scopeRefused, 'an operator was told something is refused by its own scope').toEqual([]);
  });

  /**
   * NOT `[]`, and the change is deliberate rather than a relaxation.
   *
   * This asserted that a deployment with no host objects reports no scope refusals, which held while
   * every scope-dependent capability came from an unscopeable host object. `agentRegistry` no longer
   * does: its three routes are `requirePlatformAdmin`, so it is false for an org-bound caller and true
   * for an operator on ANY deployment, host objects or none. By the list's own definition — false for
   * you, true for an operator — it belongs, and excluding it would mean filtering the derivation by
   * hand, which is the second list this whole arrangement exists to delete.
   *
   * What the case was really checking is that nothing HOST-DERIVED is reported when there are no hosts,
   * so that is what it checks now, and the agreement property above still covers this configuration
   * exactly as it covers the others.
   */
  it('reports nothing host-derived on a deployment that has no host objects', async () => {
    const { acme, ops } = await capsFor({});
    const hostDerived = ['queue', 'queueManage', 'cache', 'cacheManage', 'knowledge', 'workflowManage', 'memory'];

    expect(acme.scopeRefused.filter((k: string) => hostDerived.includes(k)),
      'a deployment with no host objects reported a host-derived scope refusal').toEqual([]);
    expect(ops.scopeRefused, 'an operator was told something is refused by its own scope').toEqual([]);
    // …and whatever IS reported must still satisfy the property: false here, true for the operator.
    for (const k of acme.scopeRefused) {
      expect([acme[k], ops[k]], `${k} is in scopeRefused but is not false-for-you and true-for-operator`)
        .toEqual([false, true]);
    }
  });
});

/**
 * DRIFT A — a capability that is false for EVERYONE is reported as scope-refused.
 *
 * `scopeRefusedCaps` pushes `queueManage` whenever the queue is unreachable, but the boolean is
 * `!!queue?.retry && hostReachable(...)`. A host that supplies a queue WITHOUT `retry` gives every
 * caller `queueManage: false` — including the operator. Measured:
 *
 *   operator true / acme false : ['cache', 'queue']
 *   scopeRefused claims        : ['cache', 'cacheManage', 'queue', 'queueManage']
 *
 * The UI then says "unavailable in your organization scope" about a Retry button that does not exist
 * for anybody, sending the operator to look at organization config for a missing host method. Same
 * wrong-place failure the list was added to prevent, pointed the other way.
 */
describe('DRIFT A: a capability nobody has is claimed as scope-refused', () => {
  it('queueManage is not scope-refused when the host never implemented retry', async () => {
    const { acme, ops } = await capsFor(NO_MANAGE);

    expect(ops.queueManage, 'the operator can manage the queue — this fixture does not reproduce the drift').toBe(false);
    expect(claimedRefusals(acme),
      'queueManage/cacheManage are listed as scope-refused although an unscoped operator cannot use '
      + 'them either — the host simply did not implement retry/invalidate')
      .not.toContain('queueManage');
  });

  it('cacheManage likewise', async () => {
    const { acme } = await capsFor(NO_MANAGE);
    expect(claimedRefusals(acme)).not.toContain('cacheManage');
  });
});

/**
 * DRIFT B — a genuinely scope-refused capability is missing from the list.
 *
 * `workflowExec` is `!!gnl?.runWorkflow || (canRunManaged && hostReachable(c, 'workflowStore'))`. With
 * no `gnl.runWorkflow`, managed execution reachable only through the host store, its value depends
 * entirely on the caller's scope — and it is not one of the seven names `scopeRefusedCaps` enumerates.
 * Measured:
 *
 *   operator true / acme false : ['workflowExec', 'workflowManage']
 *   scopeRefused claims        : ['workflowManage']
 *
 * So the workflow surface shows its ordinary "not configured" state for a scope refusal — the exact
 * defect, on the seventh gated capability, already present rather than hypothetical.
 */
describe('DRIFT B: a scope-refused capability is missing from the list', () => {
  it('workflowExec is reported when it is false only because of scope', async () => {
    const { acme, ops } = await capsFor(MANAGED_EXEC);

    expect(ops.workflowExec, 'the operator cannot run managed workflows — the fixture does not reproduce the drift').toBe(true);
    expect(acme.workflowExec, 'the organization-scoped caller can run them — nothing is refused here').toBe(false);
    expect(claimedRefusals(acme),
      'workflowExec is false for this organization and true for an operator, but is absent from '
      + 'scopeRefused — the UI cannot tell the refusal from an unconfigured deployment')
      .toContain('workflowExec');
  });
});

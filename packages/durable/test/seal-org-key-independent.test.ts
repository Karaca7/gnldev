// `org` is a SERVER-DERIVED fact with a client-readable name.
//
// The seal exists to stop a request body from supplying a key the server also derives. It covered the
// three `__gnl_*` keys and stopped there — while `@gnldev/server` documents and injects a plain `org`
// alongside them, which dynamic `system`/`model`/`tools` functions read. On the shared-scope path (no
// organization resolved — i.e. every request on a deployment that has not configured `org`) a body
// carrying `context: { org: 'victim' }` reached those functions verbatim.
//
// Two directions matter and only one of them is obvious:
//   * a client-supplied `org` must never survive, resolved or not;
//   * the server's own `org` must be WRITTEN, or every dynamic agent that reads it silently loses its
//     organization and the fix trades a hijack for an outage.
//
// The last group is the one that catches an over-broad strip: `orgUnit`, `organization` and friends
// are ordinary caller data and must pass through.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl, sealRequestContext, GNL_ORG_ID_KEY, GNL_RESOURCE_ID_KEY } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

describe('sealRequestContext and the plain `org` key', () => {
  // The shared-scope path. Nothing resolves an organization, so nothing overwrites the body's copy —
  // which is exactly why it was the path that leaked.
  it('strips a client-supplied `org` when the server resolved none', () => {
    const sealed = sealRequestContext({ org: 'victim', role: 'admin' }, {});
    expect('org' in sealed, 'a client-chosen organization reached the agent verbatim').toBe(false);
    expect(sealed.org).toBeUndefined();
    expect(sealed.role, 'ordinary caller data was collateral').toBe('admin');
  });

  it('overwrites a client-supplied `org` with the server\'s', () => {
    const sealed = sealRequestContext({ org: 'victim' }, { orgId: 'acme' });
    expect(sealed.org).toBe('acme');
  });

  // One fact, two published names. If they can disagree, a dynamic agent and the journal scope
  // describe different tenants for the same request.
  it('writes the same organization under both published names', () => {
    const sealed = sealRequestContext({}, { orgId: 'acme' });
    expect(sealed.org).toBe('acme');
    expect(sealed[GNL_ORG_ID_KEY]).toBe('acme');
    expect(sealed.org).toBe(sealed[GNL_ORG_ID_KEY]);
  });

  it('leaves `org` absent rather than present-and-undefined when the server resolved none', () => {
    const sealed = sealRequestContext({ org: 'victim' }, { resourceId: 'u-1' });
    expect(Object.keys(sealed)).not.toContain('org');
    expect(JSON.stringify(sealed)).not.toContain('victim');
    expect(sealed[GNL_RESOURCE_ID_KEY], 'the rest of the seal stopped working').toBe('u-1');
  });

  // The strip is a list of exact names. A prefix or substring rule would eat real caller data.
  it('does not touch other keys whose names begin with or contain "org"', () => {
    const ctx = { orgUnit: 'finance', organization: 'a display name', myOrg: 'x', ORG: 'shout' };
    const sealed = sealRequestContext(ctx, { orgId: 'acme' });
    expect(sealed.orgUnit).toBe('finance');
    expect(sealed.organization).toBe('a display name');
    expect(sealed.myOrg).toBe('x');
    expect(sealed.ORG).toBe('shout');
    expect(sealed.org).toBe('acme');
  });

  it('does not mutate the caller\'s object', () => {
    const ctx = { org: 'victim' };
    sealRequestContext(ctx, { orgId: 'acme' });
    expect(ctx.org, 'the request body was rewritten in place').toBe('victim');
  });

  // Single-tenant backward compatibility: a deployment with no organizations at all passes a context
  // through the seal on every request, and must get the same object back.
  it('passes an org-free context through unchanged', () => {
    const ctx = { role: 'admin', locale: 'tr', nested: { a: 1 } };
    expect(sealRequestContext(ctx, {})).toEqual(ctx);
  });
});

describe('a dynamic agent reading ctx.org', () => {
  const build = (journal: InMemoryJournal, seen: { calls: any[] }) => createGnl({
    journal,
    agents: {
      assistant: {
        model: createMockModel(async (options: any) => { seen.calls.push(options); return finalTextResult('done'); }),
        system: (ctx) => `You serve the ${ctx.org ?? 'NONE'} organization.`,
        tools: (ctx) => (ctx.org === 'victim'
          ? { victimTool: tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'ok' }) }
          : {}),
      },
    },
  });

  // The end of the chain the seal protects: what the model actually gets told.
  it('never sees an organization the caller named, when the server resolved none', async () => {
    const seen = { calls: [] as any[] };
    const gnl = build(new InMemoryJournal(), seen);
    await gnl.run('assistant', { runId: 'r-1', prompt: 'hi', context: sealRequestContext({ org: 'victim' }, {}) });

    const dump = JSON.stringify(seen.calls[0]);
    expect(dump, 'the request body chose the organization the agent serves').not.toContain('victim');
    expect(dump).toContain('NONE organization');
  });

  it('sees the server\'s organization, not the caller\'s, when one was resolved', async () => {
    const seen = { calls: [] as any[] };
    const gnl = build(new InMemoryJournal(), seen);
    await gnl.run('assistant', { runId: 'r-2', prompt: 'hi', context: sealRequestContext({ org: 'victim' }, { orgId: 'acme' }) });

    const dump = JSON.stringify(seen.calls[0]);
    expect(dump).toContain('acme organization');
    expect(dump, 'a tool set gated on the caller-supplied org was offered').not.toContain('victimTool');
  });
});

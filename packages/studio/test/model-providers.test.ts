// What the Playground offers in its model box must come from the deployment, not from our bundle.
//
// The box suggested twelve ids compiled into the UI, covering the four providers the router shipped
// with. Two things were wrong with that. A host that registered its own prefix — the whole point of
// `registerModelProvider`, added because an OpenAI-compatible endpoint (NVIDIA, Together, a gateway, a
// local server) could not be named anywhere near an agent run — saw no trace of it in the one box
// where a model is typed. And `knownModelProviders()`, which knows the answer, had no non-test caller
// at all: the registry knew, nothing asked.
//
// The second is the one that keeps costing. Providers ship models weekly, so a list that lives only in
// the bundle needs a gnl RELEASE to mention a model that came out this morning — exactly the trap
// DEFAULT_PRICING was in, and the same way out: read it from the journal and from host config.
//
// The `__pricing__` overrides are included because they are already this deployment's list of models.
// Running a model the shipped table has never heard of means pricing it, or maxCostUsd cannot fire at
// any threshold — so those ids exist already and stay current without a second place to edit.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal, registerModelProvider, PRICING_KEY } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const u of cleanup.splice(0)) u(); });

const providers = async (app: unknown) =>
  (await (await call(app as never, '/model-providers')).json()) as { providers: string[]; models: string[] };

describe('GET /model-providers', () => {
  it('reports the built-in prefixes', async () => {
    const journal = new InMemoryJournal();
    const body = await providers(createStudioApi({ reader: journal }));
    expect(body.providers).toEqual(expect.arrayContaining(['openai', 'anthropic', 'google', 'mistral']));
  });

  it('reports a prefix the host registered', async () => {
    // The symptom this endpoint exists for: the router learns `nvidia/`, and until now nothing in the
    // UI could say so.
    cleanup.push(registerModelProvider('nvidia', () => ({})));
    const body = await providers(createStudioApi({ reader: new InMemoryJournal() }));
    expect(body.providers, 'a registered provider was invisible to the UI').toContain('nvidia');
  });

  it('offers the models a host configured', async () => {
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      modelSuggestions: ['together/qwen-72b'],
    } as never);
    expect((await providers(app)).models).toContain('together/qwen-72b');
  });

  it('offers the models this deployment has PRICED, with no second place to edit', async () => {
    // Adding a model to the box is then something a user does with `gnl pricing set` or the Studio
    // Pricing page — surfaces that already exist and that they have to use anyway.
    const journal = new InMemoryJournal();
    await journal.put(PRICING_KEY, { models: { 'nvidia/llama-3.3-70b': { inputPer1M: 0.2, outputPer1M: 0.6 } } });
    const body = await providers(createStudioApi({ reader: journal, journal }));
    expect(body.models, 'a priced model did not reach the suggestion list').toContain('nvidia/llama-3.3-70b');
  });

  it('does not repeat an id that arrives from both places', async () => {
    const journal = new InMemoryJournal();
    await journal.put(PRICING_KEY, { models: { 'x/y': { inputPer1M: 1, outputPer1M: 1 } } });
    const app = createStudioApi({ reader: journal, journal, modelSuggestions: ['x/y'] } as never);
    expect((await providers(app)).models.filter((m) => m === 'x/y')).toHaveLength(1);
  });

  it('answers with an empty list rather than failing when nothing is configured', async () => {
    // The Playground renders before any of this is set up, so an empty deployment must still get a
    // usable response — the UI keeps its own offline defaults for exactly that moment.
    const body = await providers(createStudioApi({ reader: new InMemoryJournal() }));
    expect(body.models).toEqual([]);
    expect(body.providers.length).toBeGreaterThan(0);
  });

  it('is behind the read gate, unlike /capabilities', async () => {
    // /capabilities is deliberately public so the login screen can render. Which providers a
    // deployment routes to is configuration, and is not handed out before anyone has identified
    // themselves.
    const { roleAuth } = await import('@gnldev/auth');
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      auth: roleAuth({ viewer: { token: 'tok-viewer' } }),
    } as never);

    expect((await call(app as never, '/capabilities')).status, '/capabilities stopped being public').toBe(200);
    expect((await call(app as never, '/model-providers')).status).toBe(401);
    const authed = await call(app as never, '/model-providers', {
      headers: { authorization: 'Bearer tok-viewer' },
    });
    expect(authed.status).toBe(200);
  });
});

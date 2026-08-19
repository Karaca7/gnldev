// A host's own model provider, by prefix (model-router).
//
// Four built-in packages used to be the whole world, and that made the same string mean two
// different things depending on where it was typed. An app wired to an OpenAI-compatible endpoint
// could resolve `nvidia/…` in the lab — which already had a resolver hook — and could not resolve
// it anywhere near an agent run, which goes through the router. Reported from the Playground: the
// agent's own model reads as "custom", and no string a user can type reproduces it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveModel, registerModelProvider, knownModelProviders } from '../src/index.js';

describe('a host provider', () => {
  it('makes the prefix resolve like any built-in', async () => {
    const marker = { id: 'stepfun' };
    const off = registerModelProvider('nvidia', (modelId) => ({ ...marker, modelId }));
    try {
      expect(await resolveModel('nvidia/stepfun-ai/step-3.7-flash')).toEqual({
        id: 'stepfun', modelId: 'stepfun-ai/step-3.7-flash',
      });
    } finally {
      off();
    }
  });

  it('is removable, so one test cannot explain another test\'s failure', async () => {
    const off = registerModelProvider('gateway', () => ({}));
    expect(knownModelProviders()).toContain('gateway');
    off();
    expect(knownModelProviders()).not.toContain('gateway');
  });

  it('refuses to shadow a built-in', () => {
    // Silently taking over 'openai' would make every other model string in the process mean
    // something the person reading it cannot see.
    expect(() => registerModelProvider('openai', () => ({}))).toThrow(/built-in/);
  });

  it('refuses a prefix that is not one', () => {
    expect(() => registerModelProvider('', () => ({}))).toThrow(/usable prefix/);
    expect(() => registerModelProvider('a/b', () => ({}))).toThrow(/usable prefix/);
  });
});

describe('the error when nothing matches', () => {
  it('lists what IS known and says how to add one', async () => {
    // The old message named four providers and stopped there, so a user whose string worked on one
    // screen and failed on another had nothing to go on.
    await expect(resolveModel('nope/x')).rejects.toThrow(/Known: openai, anthropic, google, mistral/);
    await expect(resolveModel('nope/x')).rejects.toThrow(/registerModelProvider/);
  });

  it('still refuses a spec with no provider at all', async () => {
    await expect(resolveModel('bare-model')).rejects.toThrow(/expected 'provider\/model'/);
  });
});

// The registry as a lookup, rather than as a happy path.
//
// PROVIDER_PKG is an ordinary object literal used as a table, and the guard read it with plain
// truthiness — so every Object.prototype member answered as a built-in provider. Measured:
//
//   registerModelProvider('constructor') -> "'constructor' is a built-in provider and cannot be replaced"
//   resolveModel('constructor/x')        -> "function Object() { [native code] } is not installed"
//
// The same shape as the pricing-table bug in pricing.ts: a lookup that answers for keys nobody put in
// it. Neither is an attack — it is any id that happens to name an Object member.
describe('prefixes that are not really built-ins', () => {
  it('does not treat an inherited Object member as a registered provider', () => {
    const unregister = registerModelProvider('constructor', () => ({ id: 'custom' }));
    try {
      expect(knownModelProviders()).toContain('constructor');
    } finally {
      unregister();
    }
  });

  it('reports an unknown prefix as unknown, not as an uninstalled package', async () => {
    await expect(resolveModel('constructor/x')).rejects.toThrow(/Unknown provider 'constructor'/);
  });
});

// A prefix is a string a person types from memory into a model spec.
//
// The old check rejected only the empty string and anything containing '/', so ' openai', 'openai ',
// 'OPENAI' and 'ope nai' were all accepted — each defeating the built-in guard while LOOKING like the
// built-in it shadows. Two spellings of the same name would then resolve through different factories
// in one process, with nothing on screen to tell them apart.
describe('prefix validation', () => {
  it.each([' openai', 'openai ', 'OPENAI', 'ope nai', '  ', '', 'a/b', '_x'])(
    'refuses %j', (bad) => {
      expect(() => registerModelProvider(bad as string, () => ({}))).toThrow(/not a usable prefix|built-in/);
    },
  );

  it.each(['nvidia', 'together', 'my-gateway', 'local.llm', 'v2_provider', 'llama3'])(
    'accepts %j', (good) => {
      const unregister = registerModelProvider(good as string, () => ({}));
      expect(knownModelProviders()).toContain(good);
      unregister();
      expect(knownModelProviders()).not.toContain(good);
    },
  );

  it('still refuses to shadow a real built-in', () => {
    expect(() => registerModelProvider('openai', () => ({}))).toThrow(/built-in/);
  });
});

// Teardown must not reach past its own registration.
//
// `CUSTOM.delete(prefix)` let a STALE unregister — from a registration that had already been replaced
// — remove somebody else's live provider. Measured before the fix: two registrations of one prefix,
// and the SECOND's teardown removed the prefix outright, so the first's teardown would then have hit
// whatever was registered next. In a test suite that is one file quietly breaking the one after it.
describe('unregistering', () => {
  it('an outdated unregister does not remove the registration that replaced it', async () => {
    const first = registerModelProvider('acme', () => ({ which: 'first' }));
    const second = registerModelProvider('acme', () => ({ which: 'second' }));
    try {
      first(); // stale — must be a no-op
      expect(await resolveModel('acme/m'), 'the stale teardown removed the live provider')
        .toEqual({ which: 'second' });
    } finally {
      second();
    }
    expect(knownModelProviders()).not.toContain('acme');
  });

  it('warns when a registration replaces another, because the call sites cannot see it', async () => {
    const { vi } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = registerModelProvider('dup-warn', () => ({}));
    const b = registerModelProvider('dup-warn', () => ({}));
    try {
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('replaced an existing registration');
    } finally {
      warn.mockRestore(); a(); b();
    }
  });
});

// The model id is not host-authored config.
//
// Studio passes it straight out of an HTTP body — `resolveModel(body.model)` on
// POST /runs/:id/regression among others — so whatever a caller types reaches the host's factory
// verbatim. The obvious factory body is `createOpenAI({ baseURL, apiKey }).chat(id)`, which puts the id
// in a request URL under the deployment's credentials. Measured before the check, all of these arrived
// unchanged: '../../etc/passwd', 'https://evil.example/v1', a value containing a newline, and ''.
describe('the model id handed to a host factory', () => {
  let seen: string[];
  let unregister: () => void;
  beforeEach(() => {
    seen = [];
    unregister = registerModelProvider('probe', (id) => { seen.push(id); return { id }; });
  });
  afterEach(() => unregister());

  it.each([
    'gpt-4o',
    'meta/llama-3.1-70b-instruct',
    'claude-opus-4-5-20251101',
    'llama3:8b',            // ollama-style tag — `:` has to stay legal
    'stepfun-ai/step-3.7-flash',
  ])('passes a real model id through unchanged: %s', async (id) => {
    await resolveModel(`probe/${id}`);
    expect(seen, 'a legitimate id was rejected').toEqual([id]);
  });

  it.each([
    ['a traversal segment', '../../etc/passwd'],
    ['a whole URL', 'https://evil.example/v1'],
    ['a newline, which is the shape header injection takes', 'model\nX-Injected: 1'],
    ['a space', 'gpt 4o'],
    ['nothing at all', ''],
  ])('refuses %s', async (_why, id) => {
    await expect(resolveModel(`probe/${id}`)).rejects.toThrow(/not a usable model id/);
    expect(seen, 'the factory was called anyway').toEqual([]);
  });

  it('refuses an absurdly long id', async () => {
    await expect(resolveModel(`probe/${'a'.repeat(300)}`)).rejects.toThrow(/200/);
  });

  it('names the offending spec and why, rather than failing anonymously', async () => {
    // The caller is usually a UI field. "Unknown provider" would send them looking in the wrong place.
    await expect(resolveModel('probe/../x')).rejects.toThrow(/probe\/\.\.\/x/);
  });

  it('tells a host how to write the factory for an OpenAI-compatible server', async () => {
    // This error string was the ONLY documentation of registerModelProvider anywhere, and the obvious
    // reading of it produced the RESPONSES model — while NVIDIA NIM, Together, vLLM and Ollama serve
    // /chat/completions. A reader who guessed got a 404 from their own endpoint.
    await expect(resolveModel('nosuchprovider/x')).rejects.toThrow(/\.chat\(id\)/);
  });
});

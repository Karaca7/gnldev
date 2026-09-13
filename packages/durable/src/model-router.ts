// Model router: converts a 'provider/model' string into an AI SDK model (lazy import → no provider lock-in).
// + withModelFallback: a multi-model chain — the winner is written to the journal via CAS → DETERMINISTIC
// fallback (resume and subsequent steps stick to the same model; in most model-fallback implementations the decision isn't persistent).
import { claim, runKeys } from './journal.js';
import type { Journal } from './journal.js';

/**
 * Prefixes that map to a FIRST-PARTY `@ai-sdk/*` package, resolved lazily.
 *
 * Four of these for a long time, which quietly made the other dozen look unsupported: a host writing
 * `groq/llama-3.3` got "Unknown provider" and a pointer to `registerModelProvider`, for a package the
 * AI SDK publishes and maintains. Registering a factory by hand to reach an official provider is
 * ceremony, and the error read as a limitation of this library rather than a gap in one table.
 *
 * The key is the PREFIX and it is not cosmetic: `resolveModel` looks the factory up as
 * `mod[provider] ?? mod.default`, so a prefix that does not match the package's exported name finds
 * nothing. Every entry here is one where they agree (`@ai-sdk/groq` exports `groq`), which is also
 * why `bedrock` and `vertex` are spelled by their EXPORT rather than by their package name.
 *
 * Adding a line costs nothing at runtime — the import happens only when a spec names that prefix, and
 * an absent package produces `npm i @ai-sdk/…` rather than a failure to start. What it costs is this
 * table going stale again, so `registerModelProvider` remains the answer for anything not here:
 * every OpenAI-compatible endpoint (NVIDIA NIM, Together, vLLM, Ollama, a gateway) belongs to that
 * path permanently, because those are one API shape at many addresses, not packages anyone will ship.
 */
const PROVIDER_PKG: Record<string, string> = {
  openai: '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
  mistral: '@ai-sdk/mistral',
  groq: '@ai-sdk/groq',
  xai: '@ai-sdk/xai',
  deepseek: '@ai-sdk/deepseek',
  cohere: '@ai-sdk/cohere',
  cerebras: '@ai-sdk/cerebras',
  perplexity: '@ai-sdk/perplexity',
  fireworks: '@ai-sdk/fireworks',
  togetherai: '@ai-sdk/togetherai',
  azure: '@ai-sdk/azure',
  bedrock: '@ai-sdk/amazon-bedrock',
  vertex: '@ai-sdk/google-vertex',
  replicate: '@ai-sdk/replicate',
  // `@ai-sdk/gateway` is deliberately NOT here. It is a meta-provider — it routes to the others rather
  // than serving models itself — so a `gateway/` prefix would mean something different from every
  // other line. It is also the name model-provider-registry.test.ts registers to prove a custom
  // provider can be removed again, and promoting it to a built-in would make that test fail on the
  // shadow guard. A host that wants it registers it, which is the honest shape for a router anyway.
};

/**
 * A host's own providers, by prefix.
 *
 * Four built-in packages used to be the whole world, and that made the same string mean two
 * different things depending on which screen you typed it into: an app wired to an
 * OpenAI-compatible endpoint (NVIDIA, Together, a gateway, a local server) could resolve
 * `nvidia/…` in the lab — where a resolver hook already existed — and could not resolve it
 * anywhere near an agent run, which goes through here. Reported from the Playground, where the
 * agent's own model reads as "custom" and no string a user can type reproduces it.
 *
 * A host registers a factory and the prefix means the same thing everywhere.
 */
export type ModelProviderFactory = (modelId: string) => unknown;

const CUSTOM: Map<string, ModelProviderFactory> = new Map();

/**
 * Teaches `resolveModel` a provider prefix.
 *
 * Returns an unregister function, so a test can add one without leaking it into the next test —
 * a global that can only grow is a global that eventually explains a failure somewhere else.
 */
/**
 * What a prefix may look like: lowercase, no spaces, no slash.
 *
 * The old check rejected only `''` and anything containing `/`, so `' openai'`, `'openai '`,
 * `'OPENAI'` and `'ope nai'` were all accepted — measured. Each defeats the built-in guard below while
 * LOOKING like the built-in it shadows, and a model spec is a string a human types from memory:
 * `'OPENAI/gpt-4o'` would resolve through a host's factory while `'openai/gpt-4o'` resolved through
 * the real package, in the same process, with nothing on screen to tell them apart.
 *
 * Rejected rather than normalised on purpose. Silently lowercasing or trimming means the prefix stored
 * is not the prefix written, and the next person greps for the wrong string.
 */
const PREFIX_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Warn once per prefix that a later registration took over an earlier one. */
const overwriteWarned = new Set<string>();

export function registerModelProvider(prefix: string, factory: ModelProviderFactory): () => void {
  if (!PREFIX_RE.test(prefix ?? '')) {
    throw new Error(
      `registerModelProvider: '${prefix}' is not a usable prefix — lowercase letters, digits, '.', '_' ` +
      "and '-' only, starting with a letter or digit (no spaces, no slash, no empty string).",
    );
  }
  // `Object.hasOwn`, not truthiness: `PROVIDER_PKG[prefix]` walks the PROTOTYPE, so 'constructor',
  // 'toString', 'valueOf', '__proto__' and 'hasOwnProperty' all read as built-in providers. Measured:
  // registering any of them was refused as "a built-in provider", and `resolveModel('constructor/x')`
  // reported `function Object() { [native code] } is not installed`. Same shape as the pricing-table
  // bug in pricing.ts — an ordinary object literal used as a lookup answers for keys nobody put in it.
  if (Object.hasOwn(PROVIDER_PKG, prefix)) {
    // Refused rather than shadowed: silently taking over 'openai' would make every other model
    // string in the process mean something the person reading it cannot see.
    throw new Error(`registerModelProvider: '${prefix}' is a built-in provider and cannot be replaced`);
  }
  if (CUSTOM.has(prefix) && !overwriteWarned.has(prefix)) {
    overwriteWarned.add(prefix);
    console.warn(
      `@gnldev/durable: registerModelProvider('${prefix}') replaced an existing registration. The same ` +
      'model string now resolves through a different factory, which is invisible at every call site. ' +
      'Unregister the old one first if this was not intended.',
    );
  }
  CUSTOM.set(prefix, factory);
  // Identity-checked: an unregister function only removes the registration it installed. Plain
  // `CUSTOM.delete(prefix)` let a STALE unregister — from a registration that was already replaced —
  // delete somebody else's live provider. Measured: two registrations, and the second's teardown
  // removed the prefix entirely, so the first's teardown would then have hit whatever came next.
  return () => { if (CUSTOM.get(prefix) === factory) CUSTOM.delete(prefix); };
}

/** Every prefix `resolveModel` currently understands — built-ins first, then the host's. */
export function knownModelProviders(): string[] {
  return [...Object.keys(PROVIDER_PKG), ...CUSTOM.keys()];
}

/**
 * What may be handed to a host factory as a model id.
 *
 * This string is NOT host-authored config. Studio takes it straight out of an HTTP body —
 * `resolveModel(body.model)` on POST /runs/:id/regression among others — so whatever a caller types
 * reaches the factory verbatim. The obvious factory body is
 * `createOpenAI({ baseURL, apiKey })(modelId)`, which puts the id in a URL PATH under the deployment's
 * credentials. Measured, all of these arrived unchanged:
 *
 *   '../../etc/passwd'        a traversal, if the factory joins it onto a base path
 *   'https://evil.example/v1' a whole URL where an id was expected
 *   'model\nX-Injected: 1'    a newline, which is the shape header injection takes
 *   ''                        empty
 *
 * Real ids are namespaced words: `gpt-4o`, `meta/llama-3.1-70b-instruct`, `claude-opus-4-5-20251101`,
 * `stepfun-ai/step-3.7-flash`. The allow-list is that, and nothing is normalised — a rejected id is
 * reported, because guessing which characters the caller meant to type is how the wrong model gets
 * called quietly.
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
const MODEL_ID_MAX = 200;

function assertUsableModelId(spec: string, modelId: string): void {
  const why = !modelId
    ? 'it is empty'
    : modelId.length > MODEL_ID_MAX ? `it is ${modelId.length} characters (max ${MODEL_ID_MAX})`
      : !MODEL_ID_RE.test(modelId) ? 'it contains characters outside [A-Za-z0-9 . _ : / -] or does not start with a letter or digit'
        : modelId.split('/').includes('..') ? "it contains a '..' path segment"
          // `:` stays legal — ollama-style ids look like `llama3:8b` — but `://` is a scheme, and a
          // whole URL where an id was expected is the case that redirects a credentialed request.
          : modelId.includes('://') ? 'it looks like a URL, not a model id'
          : undefined;
  if (!why) return;
  throw new Error(
    `model: '${spec.slice(0, 80)}' is not a usable model id — ${why}. This string is passed to the ` +
    'provider factory and typically ends up in a request URL, so it is checked rather than trusted.',
  );
}

export async function resolveModel(spec: string): Promise<any> {
  const i = spec.indexOf('/');
  if (i < 0) throw new Error(`model: expected 'provider/model', got '${spec}'`);
  const provider = spec.slice(0, i);
  const modelId = spec.slice(i + 1);
  assertUsableModelId(spec, modelId);
  const custom = CUSTOM.get(provider);
  if (custom) return custom(modelId);

  // Own keys only — see registerModelProvider: an inherited 'constructor'/'toString' otherwise
  // resolved to an Object.prototype member and reported it as a missing package.
  const pkg = Object.hasOwn(PROVIDER_PKG, provider) ? PROVIDER_PKG[provider] : undefined;
  if (!pkg) {
    throw new Error(
      `Unknown provider '${provider}'. Known: ${knownModelProviders().join(', ')}. `
      + 'A host can teach this one more with registerModelProvider(prefix, factory) — '
      + 'that is what an OpenAI-compatible endpoint (NVIDIA, Together, a gateway, a local server) needs. '
      // The factory body, because this string was the ONLY documentation of the API and the obvious
      // reading of it is wrong: `createOpenAI({...})(id)` returns the RESPONSES model, while NVIDIA
      // NIM, Together, vLLM and Ollama serve /chat/completions. `.chat(id)` is the one that works, and
      // a reader who guesses gets a 404 from their own endpoint with nothing pointing here.
      + "For an OpenAI-compatible server use the CHAT model: "
      + "registerModelProvider('nvidia', (id) => createOpenAI({ baseURL, apiKey }).chat(id)).",
    );
  }
  let mod: any;
  try {
    mod = await import(pkg);
  } catch {
    throw new Error(`${pkg} is not installed for '${spec}'. Run: npm i ${pkg}`);
  }
  const factory = mod[provider] ?? mod.default;
  if (typeof factory !== 'function') {
    throw new Error(`${pkg} does not export the expected provider factory`);
  }
  return factory(modelId);
}

export interface FallbackCandidate {
  /** The stable label written to the journal: a string spec ('openai/gpt-4o') or '#<index>' for object models. */
  spec: string;
  model: any; // LanguageModelV2
}

/**
 * Deterministic model fallback: tries the candidates in order; the spec of the FIRST SUCCESSFUL call is
 * written to `<runId>:cfg:model` via CAS → the same run's subsequent steps and resumes (even after a
 * transient failure clears) use the SAME model. withDurableModel wraps AROUND this: on replay the
 * response from the journal is returned, the fallback logic never runs at all.
 */
export function withModelFallback(candidates: FallbackCandidate[], journal: Journal, runId: string): any {
  if (candidates.length === 0) throw new Error('withModelFallback: at least one candidate is required');
  if (candidates.length === 1) return candidates[0]!.model;
  const key = runKeys.cfgModel(runId);
  let sticky: number | null = null;

  const order = async (): Promise<number[]> => {
    if (sticky != null) return [sticky];
    const rec = await journal.get<{ spec: string }>(key);
    if (rec) {
      const i = candidates.findIndex((c) => c.spec === rec.spec);
      if (i >= 0) { sticky = i; return [i]; } // frozen choice: only the winner is tried
    }
    return candidates.map((_, i) => i);
  };
  const record = async (i: number): Promise<void> => {
    if (sticky === i) return;
    sticky = i;
    await claim(journal, key, { spec: candidates[i]!.spec }); // first winner; doesn't touch if already present (CAS)
  };
  /**
   * Reshapes the call's tool schemas for the candidate about to be tried. Installed by run.ts when
   * `schemaCompat` is on; absent otherwise, in which case the options pass through untouched.
   *
   * This is what makes a mixed chain actually work. The transform used to run once, before the call,
   * against whichever model the proxy claimed to be — so a chain that fell over to a different
   * provider sent it a schema shaped for the one that failed. By the time the fallback picks someone
   * else the AI SDK has already converted the tools, which looked like the end of it. It is not:
   * `options.tools[i].inputSchema` at this point is plain JSON Schema, and the compat rules are
   * JSON-Schema-to-JSON-Schema. So each candidate can be handed a schema built for it, here, at the
   * moment it is chosen.
   */
  let shapeTools: ((tools: any[], model: any) => any[]) | undefined;
  const forCandidate = (options: any, m: any): any =>
    shapeTools && Array.isArray(options?.tools) ? { ...options, tools: shapeTools(options.tools, m) } : options;

  const attempt = async <T>(fn: (m: any, opts: (o: any) => any) => Promise<T>): Promise<T> => {
    let lastErr: unknown;
    for (const i of await order()) {
      const m = candidates[i]!.model;
      try {
        const r = await fn(m, (o: any) => forCandidate(o, m));
        await record(i);
        return r;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  };

  const first = candidates[0]!.model;
  /** Whoever is actually serving: the frozen winner once known, the first candidate before that. */
  const serving = () => candidates[sticky ?? 0]!.model;
  return {
    specificationVersion: first.specificationVersion,
    // Getters, not a snapshot of candidates[0]. These fields were copied once and never updated, so
    // after anthropic failed and OpenAI served the call, the proxy still answered `anthropic` /
    // `claude-x` — measured. Anything that asks the model who it is (telemetry, logs, a host's own
    // accounting) was told the name of the candidate that did NOT run.
    get provider() { return serving().provider; },
    get modelId() { return serving().modelId; },
    get supportedUrls() { return serving().supportedUrls; },
    /** Installed by run.ts when schemaCompat is on — see `shapeTools`. */
    setToolShaper: (fn: (tools: any[], model: any) => any[]): void => { shapeTools = fn; },
    doGenerate: (options: any) => attempt((m, shaped) => m.doGenerate(shaped(options))),
    doStream: (options: any) => attempt((m, shaped) => m.doStream(shaped(options))),
  };
}


/**
 * Installs a per-candidate tool-schema shaper on a fallback chain. Returns false for a plain model
 * (and for a one-candidate chain, which `withModelFallback` short-circuits to the raw model), so the
 * caller can fall back to transforming the tools itself.
 *
 * This exists because providers' schema requirements genuinely contradict — OpenAI's strict mode
 * requires `additionalProperties: false`, Gemini rejects the keyword — so no single shape serves a
 * mixed chain. Transforming once, before the call, sent whichever candidate answered a schema built
 * for a different one. Shaping inside the retry loop gives each candidate the schema it wants.
 */
export function setChainToolShaper(model: unknown, fn: (tools: any[], model: any) => any[]): boolean {
  const set = (model as { setToolShaper?: (f: typeof fn) => void })?.setToolShaper;
  if (typeof set !== 'function') return false;
  set(fn);
  return true;
}

// Model router: converts a 'provider/model' string into an AI SDK model (lazy import → no provider lock-in).
// + withModelFallback: a multi-model chain — the winner is written to the journal via CAS → DETERMINISTIC
// Fallback (resume and subsequent steps stick to the same model; in most model-fallback implementations the decision isn't persistent).
import { claim, runKeys } from './journal.js';
import type { Journal } from './journal.js';

const PROVIDER_PKG: Record<string, string> = {
  openai: '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
  mistral: '@ai-sdk/mistral',
};

/**
 * A host's own providers, by prefix.
 *
 * Four built-in packages used to be the whole world, and that made the same string mean two
 * Different things depending on which screen you typed it into: an app wired to an
 * OpenAI-compatible endpoint (NVIDIA, Together, a gateway, a local server) could resolve
 * `nvidia/…` in the lab — where a resolver hook already existed — and could not resolve it
 * Anywhere near an agent run, which goes through here. Reported from the Playground, where the
 * Agent's own model reads as "custom" and no string a user can type reproduces it.
 *
 * A host registers a factory and the prefix means the same thing everywhere.
 */
export type ModelProviderFactory = (modelId: string) => unknown;

const CUSTOM: Map<string, ModelProviderFactory> = new Map();

/**
 * Teaches `resolveModel` a provider prefix.
 *
 * Returns an unregister function, so a test can add one without leaking it into the next test —
 * A global that can only grow is a global that eventually explains a failure somewhere else.
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
    // String in the process mean something the person reading it cannot see.
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

export async function resolveModel(spec: string): Promise<any> {
  const i = spec.indexOf('/');
  if (i < 0) throw new Error(`model: expected 'provider/model', got '${spec}'`);
  const provider = spec.slice(0, i);
  const modelId = spec.slice(i + 1);
  const custom = CUSTOM.get(provider);
  if (custom) return custom(modelId);

  // Own keys only — see registerModelProvider: an inherited 'constructor'/'toString' otherwise
  // resolved to an Object.prototype member and reported it as a missing package.
  const pkg = Object.hasOwn(PROVIDER_PKG, provider) ? PROVIDER_PKG[provider] : undefined;
  if (!pkg) {
    throw new Error(
      `Unknown provider '${provider}'. Known: ${knownModelProviders().join(', ')}. `
      + 'A host can teach this one more with registerModelProvider(prefix, factory) — '
      + 'that is what an OpenAI-compatible endpoint (NVIDIA, Together, a gateway, a local server) needs.',
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
 * Written to `<runId>:cfg:model` via CAS → the same run's subsequent steps and resumes (even after a
 * Transient failure clears) use the SAME model. withDurableModel wraps AROUND this: on replay the
 * Response from the journal is returned, the fallback logic never runs at all.
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

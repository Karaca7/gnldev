// Dynamic multi-agent routing (common supervisor/`.network()` parity) — DETERMINISM PRESERVED.
// The router LLM decides on each turn which sub-agent runs; each decision is FROZEN into the
// Journal via CAS (`<runId>:net:route:<i>`) → on resume/replay the router is NEVER CALLED AGAIN,
// The same path is followed (applying the "freeze the winner" pattern from withModelFallback to
// Routing). The sub-agent result also freezes into `<runId>:net:step:<i>` → on parent resume, a
// Completed sub-agent is skipped entirely (the same synergy as the two-level durable in
// Agent-tool; the sub-agent's own journal separately handles mid-crash resume). The loop is
// Bounded by `maxIterations` (default 6); once the limit is exceeded, the router is "forced to
// Finalize" — an unbounded router loop is structurally impossible.
import { generateText } from 'ai';
import { claim, frozenGet } from './journal.js';
import type { Journal } from './journal.js';
import type { Interrupt } from './guard.js';

/** The router's single-turn decision: either give a task to an agent OR write the final answer. */
export type RouteDecision =
  | { action: 'route'; agent: string; task: string }
  | { action: 'final'; answer: string };

/** A routable target: description text for the router + nested durable runner. */
export interface NetworkTarget {
  /** Definition the router sees when choosing an agent (if absent, only the name is listed). */
  description?: string;
  /** Durably runs the given task under a nested runId (the registry wires this to runSubAgent).
   * If `interrupts` is non-empty, the sub-agent is suspended — the network step does NOT FREEZE, the interrupt is propagated upward. */
  run(task: string, nestedRunId: string): Promise<{ text: string; interrupts?: Interrupt[] }>;
}

export interface RunNetworkOptions {
  runId: string;
  journal: Journal;
  /** Router model (materialized — the fallback chain is wrapped with withModelFallback in the registry). */
  routerModel: unknown;
  /** name → target. The router may only choose among these names. */
  agents: Record<string, NetworkTarget>;
  /** The task the network resolves. */
  task: string;
  /** Extra instructions for the router (domain knowledge, tone, constraints). */
  system?: string;
  /** Router turn cap (route count, not the total route+final decision count). Default 6. */
  maxIterations?: number;
  /**
   * P2-network optional visibility hooks into the router's
   * Otherwise-silent blocking decisions. See `NetworkObserver` for the full replay-visibility + veto contract.
   */
  observer?: NetworkObserver;
}

/** A delegation veto — returned from `onAgentStart` to skip a sub-agent's run entirely. */
export interface DelegationVeto {
  skip: true;
  /** Fed to the router's NEXT turn as if it were the sub-agent's own result. Default: ''. */
  replaceResult?: string;
}

/**
 * P2-network (GAP 5/7 — common network-routing observability parity: `routing-agent-*`/`agent-execution-*`
 * Stream events + `onDelegationStart`/`onDelegationComplete`). The router's `generateText` call stays
 * BLOCKING and journaled/CAS-frozen exactly as before (see the file header) — these hooks ADD
 * Visibility into an otherwise-silent wait, they do NOT change determinism or turn this into a stream.
 *
 * ALL hooks are OPTIONAL and BEST-EFFORT: each call is individually wrapped — a throwing observer is
 * Caught and logged via `console.warn`, it can NEVER break the run (see the internal `notify()` helper).
 *
 * REPLAY-VISIBILITY CONTRACT (read this before wiring a UI): on a FRESH run every hook fires once,
 * Live, in order `onRouteStart → onRouteDecision → [onAgentStart → onAgentFinish] → onFinal` per
 * Iteration. On RESUME, every hook whose data is already FROZEN in the journal (route decision,
 * Sub-agent result, veto) FIRES AGAIN — so a UI can reconstruct the full timeline from a resumed run —
 * But is marked cached and the underlying router/agent call is NEVER repeated:
 * `onRouteDecision`'s `fromCache` is `true` when the decision was read from the journal instead of freshly computed.
 * `onAgentStart`'s `fromCache` is `true` when the step (or its veto) was already frozen — in that
 *     Case its return value is IGNORED: no new veto decision is solicited, the frozen outcome always wins.
 * `onAgentFinish` receives `{ cached: true }` (instead of the real result) when replaying a frozen step.
 */
export interface NetworkObserver {
  /** Fires right before the router is (re)consulted for iteration `iter`. `contextSummary` is the
   *  Same steps-so-far digest the router itself is prompted with. */
  onRouteStart?(iter: number, contextSummary: string): void | Promise<void>;
  /** Fires once the routing decision for `iter` is known (route or final). `fromCache` is true on replay. */
  onRouteDecision?(iter: number, decision: RouteDecision, fromCache: boolean): void | Promise<void>;
  /**
   * Fires before a chosen sub-agent runs. Return `{ skip: true, replaceResult? }` (sync or async) to
   * VETO the delegation — the sub-agent is never invoked, and `replaceResult` (default '') is frozen
   * As this step's result, fed to the router's next turn exactly like a real sub-agent answer would be.
   * The veto decision is JOURNALED (`net:<runId>:veto:<iter>`, claim-keyed) so it replays deterministically.
   */
  onAgentStart?(
    iter: number,
    agentName: string,
    input: string,
    fromCache?: boolean,
  ): void | DelegationVeto | Promise<void | DelegationVeto>;
  /** Fires once a sub-agent step is resolved — a real `{ text }` result, or `{ cached: true }` on replay. */
  onAgentFinish?(iter: number, agentName: string, result: { text: string } | { cached: true }): void | Promise<void>;
  /** Fires once with the router's final answer (both the natural 'final' decision and the forced-final path). */
  onFinal?(text: string): void | Promise<void>;
}

/**
 * Best-effort observer invocation: awaits the callback (sync or async) and swallows any throw (logs
 * Via console.warn instead) — an observer bug must NEVER break the run (P2-network).
 */
async function notify<A extends unknown[], R>(
  fn: ((...args: A) => R | Promise<R>) | undefined,
  ...args: A
): Promise<R | undefined> {
  if (!fn) return undefined;
  try {
    return await fn(...args);
  } catch (e) {
    console.warn(`@gnldev/durable network: observer callback threw — ignored (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
}

export interface NetworkStep {
  i: number;
  agent: string;
  task: string;
  text: string;
}

export interface NetworkResult {
  runId: string;
  /** The router's final answer (empty if suspended). */
  text: string;
  /** The sub-agent steps that ran (dynamic tree — the studio Networks view reads this). */
  steps: NetworkStep[];
  /** How many routing turns ran. */
  iterations: number;
  /** Set if the limit was exceeded and the router was forced to finalize. */
  stopped?: 'max-iterations';
  /** Approval interrupts propagated up from a sub-agent (same contract as runDurable; empty = no interrupt). */
  interrupts: Interrupt[];
  /** If interrupts is non-empty, which step is suspended — after approval, calling again with the SAME
   *  RunId resumes where it left off (the route decision is frozen, the sub-agent resumes from its own journal). */
  suspended?: { i: number; agent: string; task: string };
}

/** Network journal keys — do not match the `:(model|tool):` pattern → invisible to parseJournalKey. */
export const netKeys = {
  route: (runId: string, i: number | 'final') => `${runId}:net:route:${i}`,
  step: (runId: string, i: number) => `${runId}:net:step:${i}`,
  /** The runId of the sub-agent's own journal (deterministic — NOT tied to toolCallId).
   * NOTE: this nested run appears in listRuns/Studio Runs as a SEPARATE top-level run
   *  (nested-run ontology — see the core-hardening review). */
  nestedRunId: (runId: string, i: number) => `net:${runId}:${i}`,
  /** P2-network: a delegation veto (`onAgentStart` returning `{skip:true}`) — claim-keyed, frozen
   * BEFORE the step itself so a crash between the two claims still replays the SAME veto on resume
   *  (mirrors the `route`/`step` two-record freezing pattern above). */
  veto: (runId: string, i: number) => `${runId}:net:veto:${i}`,
} as const;

/** Steps-so-far digest — shared by the router prompt AND the observer's `onRouteStart` notification. */
function summarizeHistory(history: NetworkStep[]): string {
  return history.length
    ? history.map((h) => `[${h.i}] agent=${h.agent} task="${h.task}" → result: ${h.text}`).join('\n')
    : '(no steps yet)';
}

/** Router prompt: target list + task + history; strict JSON is requested. */
function routerPrompt(opts: RunNetworkOptions, history: NetworkStep[], force: 'final' | null): string {
  const agentList = Object.entries(opts.agents)
    .map(([name, t]) => `- ${name}${t.description ? `: ${t.description}` : ''}`)
    .join('\n');
  const past = summarizeHistory(history);
  const actions = force === 'final'
    ? `Iteration limit reached. MANDATORY: write the final answer from the results at hand:\n{"action":"final","answer":"<answer>"}`
    : `Choose ONE of these two actions and respond with ONLY a single line of JSON:\n` +
      `{"action":"route","agent":"<agent name>","task":"<clear task to give that agent>"}\n` +
      `{"action":"final","answer":"<final answer for the user>"}`;
  return (
    `You are a router (supervisor) agent. Solve the task by splitting it across sub-agents.\n` +
    (opts.system ? `${opts.system}\n` : '') +
    `\nAvailable agents:\n${agentList}\n` +
    `\nMain task: ${opts.task}\n` +
    `\nSteps so far:\n${past}\n\n${actions}`
  );
}

/**
 * Extracts the FIRST balanced JSON object in the text (string/escape aware). A greedy `\{[\s\S]*\}`
 * Regex would break by capturing from the first '{' to the LAST '}' if the router echoes two template objects at once.
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null; // unbalanced — the caller retries
}

/** Extracts + validates the first JSON object from the router's response. Throws Error if invalid (the caller retries). */
function parseDecision(text: string, agents: Record<string, NetworkTarget>, force: 'final' | null): RouteDecision {
  const raw = firstJsonObject(text);
  if (!raw) throw new Error(`no JSON in router response: ${text.slice(0, 200)}`);
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`router JSON could not be parsed: ${raw.slice(0, 200)}`);
  }
  if (obj.action === 'final' && typeof obj.answer === 'string') return { action: 'final', answer: obj.answer };
  if (force === 'final') throw new Error(`router was forced to final but did not return 'final': ${raw.slice(0, 200)}`);
  if (obj.action === 'route' && typeof obj.agent === 'string' && typeof obj.task === 'string') {
    if (!agents[obj.agent]) {
      throw new Error(`router picked an unknown agent: '${obj.agent}'. Valid: ${Object.keys(agents).join(', ')}`);
    }
    return { action: 'route', agent: obj.agent, task: obj.task };
  }
  throw new Error(`router decision not recognized: ${raw.slice(0, 200)}`);
}

/** Calls the router LLM and parses the decision; if the first attempt is malformed, feeds the error back and retries ONCE more.
 *  (Retries happen INSIDE a single frozen step → only the final decision is written to the journal, determinism is not broken.) */
async function decideOnce(opts: RunNetworkOptions, history: NetworkStep[], force: 'final' | null): Promise<RouteDecision> {
  const base = routerPrompt(opts, history, force);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? base : `${base}\n\nYour previous answer was invalid (${String((lastErr as Error)?.message)}). Respond with only a single line of valid JSON.`;
    const { text } = await generateText({ model: opts.routerModel as any, prompt });
    try {
      return parseDecision(text, opts.agents, force);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`@gnldev/durable network: router could not produce a valid decision — ${String((lastErr as Error)?.message)}`);
}

/**
 * Runs the dynamic agent network: route decision → sub-agent → append to history → repeat; until
 * The router says 'final' or `maxIterations` is exhausted. Every decision and every step result
 * Freezes into the journal → calling again with the same runId (resume) returns the same result without an LLM (exactly-once).
 */
export async function runNetwork(opts: RunNetworkOptions): Promise<NetworkResult> {
  if (Object.keys(opts.agents).length === 0) {
    throw new Error('@gnldev/durable network: at least one agent is required');
  }
  const maxIterations = opts.maxIterations ?? 6;
  const steps: NetworkStep[] = [];
  const obs = opts.observer;

  for (let i = 0; i < maxIterations; i++) {
    const routeKey = netKeys.route(opts.runId, i);
    const routeFromCache = (await opts.journal.get(routeKey)) !== undefined;
    if (obs) await notify(obs.onRouteStart, i, summarizeHistory(steps));
    const decision = await frozenGet(opts.journal, routeKey, () => decideOnce(opts, steps, null));
    if (obs) await notify(obs.onRouteDecision, i, decision, routeFromCache);
    if (decision.action === 'final') {
      if (obs) await notify(obs.onFinal, decision.answer);
      return { runId: opts.runId, text: decision.answer, steps, iterations: i, interrupts: [] };
    }
    // If the frozen decision's agent is no longer registered, fail clearly (instead of silently drifting).
    const target = opts.agents[decision.agent];
    if (!target) {
      throw new Error(`@gnldev/durable network: frozen decision requires agent '${decision.agent}' but it is not registered`);
    }
    // The step result freezes CONDITIONALLY: if the sub-agent was suspended (interrupts is
    // Non-empty) it is NOT FROZEN — otherwise an empty/half-finished text would become permanent
    // And even resume couldn't fix it. On calling again with the same runId after approval: the
    // Route decision is frozen (the router does not run), the sub-agent resumes from its own
    // Journal, and once it completes, the step freezes then.
    const stepKey = netKeys.step(opts.runId, i);
    const vetoKey = netKeys.veto(opts.runId, i);
    const stepHit = await opts.journal.get<{ v: Omit<NetworkStep, 'i'> }>(stepKey);
    let res: Omit<NetworkStep, 'i'>;
    if (stepHit !== undefined) {
      // Already fully resolved (executed OR vetoed) in an earlier attempt — pure replay: notify with
      // The cached markers, do NOT re-invoke the delegation callback for a decision, no re-execution.
      res = stepHit.v;
      if (obs) {
        await notify(obs.onAgentStart, i, decision.agent, decision.task, true);
        await notify(obs.onAgentFinish, i, decision.agent, { cached: true });
      }
    } else {
      // P2-network: a veto may have been journaled in an earlier attempt that crashed BEFORE the step
      // Itself froze (the two-claim window) — replay that SAME veto instead of asking again.
      const vetoHit = await opts.journal.get<{ v: { replaceResult?: string } }>(vetoKey);
      let vetoed: boolean;
      let replaceResult: string | undefined;
      if (vetoHit !== undefined) {
        vetoed = true;
        replaceResult = vetoHit.v.replaceResult;
        if (obs) await notify(obs.onAgentStart, i, decision.agent, decision.task, true);
      } else {
        const verdict = obs
          ? ((await notify(obs.onAgentStart, i, decision.agent, decision.task, false)) as DelegationVeto | void | undefined)
          : undefined;
        vetoed = !!(verdict && (verdict as DelegationVeto).skip === true);
        if (vetoed) {
          replaceResult = (verdict as DelegationVeto).replaceResult;
          await claim(opts.journal, vetoKey, { v: { replaceResult } });
        }
      }
      if (vetoed) {
        res = { agent: decision.agent, task: decision.task, text: replaceResult ?? '' };
        if (!(await claim(opts.journal, stepKey, { v: res }))) {
          res = (await opts.journal.get<{ v: Omit<NetworkStep, 'i'> }>(stepKey))!.v; // read the race winner
        }
        if (obs) await notify(obs.onAgentFinish, i, decision.agent, { text: res.text });
      } else {
        const r = await target.run(decision.task, netKeys.nestedRunId(opts.runId, i));
        if (r.interrupts && r.interrupts.length > 0) {
          return {
            runId: opts.runId, text: '', steps, iterations: i,
            interrupts: r.interrupts, suspended: { i, agent: decision.agent, task: decision.task },
          };
        }
        res = { agent: decision.agent, task: decision.task, text: r.text };
        if (!(await claim(opts.journal, stepKey, { v: res }))) {
          res = (await opts.journal.get<{ v: Omit<NetworkStep, 'i'> }>(stepKey))!.v; // read the race winner
        }
        if (obs) await notify(obs.onAgentFinish, i, decision.agent, { text: res.text });
      }
    }
    steps.push({ i, ...res });
  }

  // Limit exhausted → the router is forced to finalize (that decision also freezes). If the router
  // Still can't produce a final in 2 attempts, best-effort INSTEAD OF CRASHING: the last step's text (derived from frozen steps → deterministic).
  let answer: string;
  try {
    const finalKey = netKeys.route(opts.runId, 'final');
    const finalFromCache = (await opts.journal.get(finalKey)) !== undefined;
    if (obs) await notify(obs.onRouteStart, maxIterations, summarizeHistory(steps));
    const forced = await frozenGet(opts.journal, finalKey, () => decideOnce(opts, steps, 'final'));
    if (obs) await notify(obs.onRouteDecision, maxIterations, forced, finalFromCache);
    answer = forced.action === 'final' ? forced.answer : (steps[steps.length - 1]?.text ?? '');
  } catch {
    answer = steps[steps.length - 1]?.text ?? '';
  }
  if (obs) await notify(obs.onFinal, answer);
  return { runId: opts.runId, text: answer, steps, iterations: maxIterations, stopped: 'max-iterations', interrupts: [] };
}

/** Extracts a network run's dynamic tree from the journal (studio Networks view / observability). */
export async function getNetworkTrace(
  journal: Journal,
  runId: string,
): Promise<{ routes: { i: number | 'final'; decision: RouteDecision }[]; steps: NetworkStep[] }> {
  if (typeof journal.listKeys !== 'function') {
    throw new Error('@gnldev/durable network: getNetworkTrace requires a journal that supports `listKeys`');
  }
  const keys = await journal.listKeys(`${runId}:net:`);
  const routes: { i: number | 'final'; decision: RouteDecision }[] = [];
  const steps: NetworkStep[] = [];
  for (const key of keys) {
    const suffix = key.slice(`${runId}:net:`.length);
    const rec = await journal.get<{ v: any }>(key);
    if (rec === undefined) continue;
    if (suffix.startsWith('route:')) {
      const raw = suffix.slice('route:'.length);
      routes.push({ i: raw === 'final' ? 'final' : Number(raw), decision: rec.v });
    } else if (suffix.startsWith('step:')) {
      steps.push({ i: Number(suffix.slice('step:'.length)), ...rec.v });
    }
  }
  const idx = (x: number | 'final') => (x === 'final' ? Number.MAX_SAFE_INTEGER : x);
  routes.sort((a, b) => idx(a.i) - idx(b.i));
  steps.sort((a, b) => a.i - b.i);
  return { routes, steps };
}

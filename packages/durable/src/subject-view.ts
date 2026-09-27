/**
 * Subject scoping, built ONCE next to `withOrg`/`withOrgStorage`, so every door (REST, chat, AG-UI,
 * MCP) that hands an end user a journal or a memory hands them the same view.
 *
 * The rule the per-route gates spelled out 29 times, and missed on the routes nobody opened: an end
 * user reaches a run or a thread only when its recorded owner IS that user. Written as a view rather
 * than a check, so a route that forgets to ask still gets nothing foreign — the reader it holds cannot
 * produce it.
 *
 * OWNERLESS IS FAIL-CLOSED. A run with no `resourceId` in its `:input`, or a thread whose store cannot
 * say who owns it (`getThreadResource` absent), belongs to nobody the view can prove is this user, so
 * it is not this user's. That is the difference from the gates, which pass on an unknown owner — and
 * the reason an operator-started run was readable by any end user who guessed its id.
 *
 * A KEY IS READ THROUGH ITS RUN. `get` answers only for a key under a run this user owns — and a run
 * id may contain ':', so one key can sit under several. Every run it could belong to must be this
 * user's, and there must be at least one; a key under no run (registry rows aside) is nobody's. The
 * other readings are exploitable: "the longest prefix wins" lets a user name a run `<victim>:wf` and
 * claim the victim's `:wf:` steps. Under "all of them", naming a run after someone's prefix can block
 * a read and can never make one.
 *
 * THE ROOT IS NOT A PARTITION. Organization rows live physically in the root under `org:<id>:`. An
 * end user served from the root (no organization bound) must see the root's own rows and no
 * organization's; `root: true` hides every id carrying the organization prefix.
 *
 * Staff never get this view: operators work across their scope by design.
 */
import type { Journal, JournalReader, RunSummary } from './journal.js';
import type { Memory } from './memory.js';
import type { SubjectViewBrand } from './run-identity.js';

const ORG_PREFIX = 'org:';
/** @gnldev/workflow's run registry: one `wfrun:<runId>` row per workflow run. */
const WF_REGISTRY = 'wfrun:';

export interface SubjectViewOptions {
  /** The wrapped store is the unscoped root, which physically holds every organization's rows. */
  root?: boolean;
  /**
   * Who owns a thread when the memory cannot say (`getThreadResource` absent, e.g. `BasicMemory`).
   * Without it such a thread is refused to every end user, its owner included. `threadOwnerFromRuns`
   * answers from the run journal, which records `threadId` and `resourceId` on every run's `:input`.
   */
  threadOwner?: (threadId: string) => Promise<string | undefined>;
}

/**
 * A thread's owner as the RUN JOURNAL records it: the single `resourceId` every run on that thread
 * carries. Two different owners, or any ownerless run on it, answer `undefined` — a thread the journal
 * cannot pin to one user is pinned to none. A full listing per call: correct, not cheap.
 */
export function threadOwnerFromRuns(journal: Partial<JournalReader>): (threadId: string) => Promise<string | undefined> {
  return async (threadId) => {
    if (!journal.listRuns) return undefined;
    const owners = new Set((await journal.listRuns()).filter((r) => r.threadId === threadId).map((r) => r.resourceId));
    return owners.size === 1 ? [...owners][0] : undefined;
  };
}

/** A forwarding view: overrides win, everything else is the target's own, bound to the target. */
function view<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    has: (t, prop) => (Object.prototype.hasOwnProperty.call(overrides, prop) ? overrides[prop] !== undefined : Reflect.has(t, prop)),
  });
}

export function withSubjectJournal<J extends Journal & Partial<JournalReader>>(journal: J, subject: string, opts: SubjectViewOptions = {}): J & SubjectViewBrand {
  if (!subject) throw new Error('@gnldev/durable: withSubjectJournal needs a non-empty subject');
  const foreignKey = (key: string) => opts.root === true && key.startsWith(ORG_PREFIX);
  // ONE owner lookup per run for the view's lifetime (a view is built per request): the key rule
  // below asks about every ':'-prefix of every key, and a 400-key listing used to cost 400×N reads.
  const owners = new Map<string, Promise<{ resourceId?: string } | undefined | 'error'>>();
  const inputOf = (runId: string) => {
    let p = owners.get(runId);
    if (!p) {
      p = journal.get<{ resourceId?: string }>(`${runId}:input`).then((v) => v, () => 'error' as const);
      owners.set(runId, p);
    }
    return p;
  };
  const ownerOf = async (runId: string): Promise<string | undefined> => {
    const v = await inputOf(runId);
    return v === 'error' ? undefined : v?.resourceId;
  };
  const mine = async (runId: string) => !foreignKey(runId) && (await ownerOf(runId)) === subject;
  // Every run `key` could belong to: each ':'-bounded prefix that has a frozen input. A registry row
  // (`wfrun:<runId>`) is its run's, so it is read as if it were `<runId>:`.
  // `listed`: a listing already in hand. A candidate run whose `:input` key falls inside the listed
  // range EXISTS only if the listing holds that key — answered without a read, so a 400-key listing of
  // one run costs one owner read, not one per key per ':'.
  const keyIsMine = async (key: string, listed?: { prefix: string; inputs: Set<string> }): Promise<boolean> => {
    if (foreignKey(key)) return false;
    const base = key.startsWith(WF_REGISTRY) ? `${key.slice(WF_REGISTRY.length)}:` : key;
    let claimed = false;
    for (let i = base.indexOf(':'); i > 0; i = base.indexOf(':', i + 1)) {
      const runId = base.slice(0, i);
      if (listed && `${runId}:input`.startsWith(listed.prefix) && !listed.inputs.has(runId)) continue;
      const input = await inputOf(runId);
      if (input === 'error') return false;
      if (input === undefined) continue;
      if (input?.resourceId !== subject) return false;
      claimed = true;
    }
    return claimed;
  };
  const visible = (r: RunSummary) => r.resourceId === subject && !foreignKey(r.runId);
  return view(journal, {
    // The brand: decisions (run-identity.ts, cancelWorkflowRun) refuse a view at runtime too.
    __gnlSubjectView: true,
    get: async (key: string) => ((await keyIsMine(key)) ? journal.get(key) : undefined),
    listKeys: journal.listKeys
      ? async (prefix: string) => {
          const out: string[] = [];
          const keys = await journal.listKeys!(prefix);
          const listed = { prefix, inputs: new Set(keys.filter((k) => k.endsWith(':input')).map((k) => k.slice(0, -':input'.length))) };
          for (const k of keys) if (await keyIsMine(k, listed)) out.push(k);
          return out;
        }
      : undefined,
    readRun: journal.readRun ? async (runId: string) => ((await mine(runId)) ? journal.readRun!(runId) : []) : undefined,
    readRunStats: journal.readRunStats
      ? async (runId: string) => ((await mine(runId)) ? journal.readRunStats!(runId) : { entries: 0, bytes: 0 })
      : undefined,
    listRuns: journal.listRuns ? async () => (await journal.listRuns!()).filter(visible) : undefined,
    listRunsPaged: journal.listRunsPaged
      ? async (q?: Parameters<NonNullable<JournalReader['listRunsPaged']>>[0]) => {
          const page = await journal.listRunsPaged!({ ...q, resourceId: subject });
          return { ...page, items: page.items.filter(visible) };
        }
      : undefined,
    // A count across every owner is exactly what this view withholds.
    countRunsByStatus: undefined,
  }) as J & SubjectViewBrand;
}

export function withSubjectMemory<M extends Memory>(memory: M, subject: string, opts: SubjectViewOptions = {}): M {
  if (!subject) throw new Error('@gnldev/durable: withSubjectMemory needs a non-empty subject');
  const foreign = (threadId: string) => opts.root === true && threadId.startsWith(ORG_PREFIX);
  const mine = async (threadId: string): Promise<boolean> => {
    if (foreign(threadId)) return false;
    // A caller-supplied answer wins: the server hands the owner RECORD's (thread-owner.ts), which a
    // memory's own `getThreadResource` may not agree with for a thread opened before it existed.
    const lookup = opts.threadOwner ?? (memory.getThreadResource ? (t: string) => memory.getThreadResource!(t) : undefined);
    if (!lookup) return false;
    try { return (await lookup(threadId)) === subject; } catch { return false; }
  };
  const own = async () => {
    const rows = memory.listThreads ? await memory.listThreads({ resourceId: subject }) : [];
    return rows.filter((r) => !foreign(String((r as { id?: unknown })?.id ?? '')));
  };
  return view(memory, {
    getMessages: async (threadId: string, o?: Parameters<Memory['getMessages']>[1]) =>
      ((await mine(threadId)) ? memory.getMessages(threadId, o?.resourceId !== undefined ? { ...o, resourceId: subject } : o) : []),
    getWorkingMemory: memory.getWorkingMemory
      ? async (threadId: string) => ((await mine(threadId)) ? memory.getWorkingMemory!(threadId) : undefined)
      : undefined,
    listThreads: async () => own(),
    listAllThreads: async () => own(),
  });
}

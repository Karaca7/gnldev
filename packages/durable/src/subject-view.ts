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
 * THE ROOT IS NOT A PARTITION. Organization rows live physically in the root under `org:<id>:`. An
 * end user served from the root (no organization bound) must see the root's own rows and no
 * organization's; `root: true` hides every id carrying the organization prefix.
 *
 * Staff never get this view: operators work across their scope by design.
 */
import type { Journal, JournalReader, RunSummary } from './journal.js';
import type { Memory } from './memory.js';

const ORG_PREFIX = 'org:';

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

export function withSubjectJournal<J extends Journal & Partial<JournalReader>>(journal: J, subject: string, opts: SubjectViewOptions = {}): J {
  if (!subject) throw new Error('@gnldev/durable: withSubjectJournal needs a non-empty subject');
  const foreignKey = (key: string) => opts.root === true && key.startsWith(ORG_PREFIX);
  const ownerOf = async (runId: string): Promise<string | undefined> => {
    try { return (await journal.get<{ resourceId?: string }>(`${runId}:input`))?.resourceId; } catch { return undefined; }
  };
  const mine = async (runId: string) => !foreignKey(runId) && (await ownerOf(runId)) === subject;
  const visible = (r: RunSummary) => r.resourceId === subject && !foreignKey(r.runId);
  return view(journal, {
    get: async (key: string) => (foreignKey(key) ? undefined : journal.get(key)),
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
  });
}

export function withSubjectMemory<M extends Memory>(memory: M, subject: string, opts: SubjectViewOptions = {}): M {
  if (!subject) throw new Error('@gnldev/durable: withSubjectMemory needs a non-empty subject');
  const foreign = (threadId: string) => opts.root === true && threadId.startsWith(ORG_PREFIX);
  const mine = async (threadId: string): Promise<boolean> => {
    if (foreign(threadId)) return false;
    const lookup = memory.getThreadResource ? (t: string) => memory.getThreadResource!(t) : opts.threadOwner;
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

import { createHash } from 'node:crypto';

/**
 * The NUL that opens every tag, and the SOURCE of the escaping rule below.
 *
 * The dependency runs NUL → TAG, never the other way around. An earlier shape derived the escape
 * character from the tag (`const NUL = TAG[0]`), which coupled two unrelated decisions: editing the
 * tag's TEXT silently changed which caller keys get escaped. Rewriting `TAG` as `'gnl:'` made `NUL`
 * become `'g'`, so every ordinary key starting with `g` was escaped (`{greeting:'hi'}` serialized as
 * `{"ggreeting":"hi"}`) — a compatibility break that the whole suite stayed green through, because no
 * frozen vector had a `g` key. Golden vectors below now cover the leading characters of the tag, and
 * `the tag namespace is pinned` asserts the exact tag strings, so neither half can drift unnoticed.
 */
const NUL = '\u0000';

/**
 * Tag prefix for non-plain-JSON values (Date/Map/Set/RegExp/URL/URLSearchParams/BigInt).
 *
 * WHY a tag at all: `JSON.stringify` reaches these types through `Object.keys()`, which sees NO
 * enumerable own keys on any of them — so every one of them used to collapse to `{}` and share a
 * single hash (`44136fa355b3678a` for a bare value). Two DIFFERENT `Date`s therefore looked like the
 * SAME arguments and `idempotency: 'args'` swallowed the second call as a duplicate.
 *
 * WHY the tag is shaped like this: a NUL-prefixed key cannot realistically appear in a JSON object
 * produced by a caller, so `new Map([['a', 1]])` and `{ a: 1 }` can never serialize to the same
 * string. The type name is embedded in the key (not in a sibling field) so a single key carries
 * both the discriminator and the payload — no key-order question arises.
 */
const TAG = `${NUL}gnl:`;

/** One-key wrapper: `{"\u0000gnl:Date": "2020-01-01T00:00:00.000Z"}`. */
function tagged(type: string, payload: unknown): Record<string, unknown> {
  return { [TAG + type]: payload };
}

/**
 * Keeps the tag namespace disjoint from caller data ON THE OBJECT-KEY PATH.
 *
 * "A NUL-prefixed key cannot realistically appear in caller JSON" is a claim about likelihood, not a
 * guarantee: JSON permits a NUL inside a key, so a caller — or a model emitting tool arguments — CAN
 * hand us a plain object whose single key is literally the Date tag. Without escaping that object
 * serializes exactly like a real `Date` and collides (measured, not hypothetical). This is the path
 * that MATTERS, because it survives `JSON.parse`: it is reachable by anything that can put bytes on
 * the wire, and `idempotency: 'args'` deduplicates BILLABLE calls on this hash. Note the collision
 * class did not exist before tagging — it is introduced by the tags themselves, and closed here.
 *
 * Escaping prepends one NUL to any key that already starts with one. It is injective (each further
 * level of NUL stays distinct) and `tagged()` only ever emits a SINGLE-NUL key, so an escaped caller
 * key can never equal a tag. Keys not starting with NUL — every realistic key — pass through
 * untouched, which is what keeps the compatibility constraint documented below intact.
 *
 * SCOPE, precisely: this closes the object-key path only. It does NOT make the tag namespace
 * unreachable in general — see the `toJSON` note in `sortKeys`, where the residue is spelled out.
 */
function escapeKey(key: string): string {
  return key.startsWith(NUL) ? NUL + key : key;
}

/**
 * Sort helper for Map/Set members: their normalized form serialized to a comparable string.
 * Compared with plain `<`/`>` (NOT `localeCompare`) — collation is locale-dependent, and a hash that
 * shifted with the host's locale would break replay across machines. `member order is UTF-16 code
 * units, not locale collation` pins this: under most collations `'a' < 'B'`, under code units it is
 * `'B' < 'a'`, so swapping in `localeCompare` turns that test red.
 */
function sortToken(value: unknown): string {
  return String(JSON.stringify(value));
}

function compareTokens(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic JSON, independent of key order.
 *
 * COMPATIBILITY CONSTRAINT (do not break): the returned string feeds `argsHash`, which feeds the
 * journal key in `durable-tool.ts` (`runKeys.toolByArgs` / `runKeys.toolCrossRun`) AND the drift
 * detector. Changing the output for arguments that are already handled correctly would orphan the
 * journal records of in-flight runs and make them re-execute (or trip `DivergenceError`) on resume.
 * So PLAIN JSON — string / number / boolean / null / array / plain object — MUST keep producing the
 * byte-identical output it produced before. Only values that were provably broken (indistinguishable
 * from `{}`, or outright throwing) are allowed to change.
 *
 * Returns `undefined` — not a string, despite the annotation — for values JSON cannot represent at
 * all (`undefined`, a function, a symbol). That predates this file's current shape and is relied on
 * by the `putIfMatch` comparisons in `journal.ts` / `redis-storage.ts` / `in-memory-storage.ts`, so
 * the signature is left alone; `argsHash` handles the case explicitly instead.
 *
 * THROWS a `TypeError` for a circular value (see `circularReference`). It threw before too — as
 * `RangeError: Maximum call stack size exceeded` — so no caller loses a result it used to get.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * The descent state threaded through `sortKeys`, holding the two things a recursive walk cannot
 * recover after the fact: which objects are currently OPEN (the ancestors of the value being looked
 * at) and how we got to them.
 *
 * `open` is the cycle detector, and the reason it is a per-descent Set rather than a "everything I
 * have ever seen" Set is the distinction this whole mechanism turns on: a SHARED reference is not a
 * cycle. `{ x: shared, y: shared }` is ordinary, hashes today, and must keep hashing — the same
 * object is simply reached twice by two disjoint paths. A cycle is the strictly narrower case where
 * an object contains ITSELF, i.e. is reached again while it is still open. So membership is added on
 * the way down and removed on the way out (`finally`, so a throwing `toJSON` cannot leave residue).
 * A plain `Set` rather than a `WeakSet`: the state lives for the duration of one `stableStringify`
 * call and never outlives it, so there is nothing for weak references to collect, and it holds at
 * most one entry per level of nesting.
 */
type Descent = { open: Set<object>; path: string[] };

/**
 * A cycle can never be hashed — not with a bigger stack, not on a retry, not with fewer arguments.
 * That is why the type is `TypeError` and not the `RangeError` this used to produce: a stack
 * overflow reads as RESOURCE EXHAUSTION, which points a caller's error handling (and any retry
 * policy wrapped around a tool) at a remedy that cannot exist. `JSON.stringify` reports the same
 * input as a `TypeError` for the same reason.
 *
 * The path is the part a caller actually needs. Tool arguments arrive as one large object — often
 * model-generated — and `$.a.b.back` is the difference between a fix and an afternoon of bisecting.
 *
 * SCOPE: cycles only. A value that is DEEP but acyclic still ends in `RangeError: Maximum call stack
 * size exceeded`, and no depth cap is imposed on purpose. A cycle can never be hashed, so turning it
 * into an error costs nothing; a depth cap is the opposite trade — it would REJECT values that hash
 * successfully today, and any number picked would have to sit below the stack ceiling to ever fire.
 * That ceiling is not a contract to begin with: measured on one host, this normalizer handled 1796
 * levels before this change and 1122 after (the extra frame per level), while `JSON.stringify`
 * managed 4086 — three different numbers on one machine, all of them stack-size dependent. Buying
 * unbounded depth means an explicit-stack rewrite of a function whose byte-exact output is a journal
 * key, which is not worth it for inputs a thousand levels deep.
 */
function circularReference(path: readonly string[]): TypeError {
  return new TypeError(
    `@gnldev/durable: circular reference in the value being hashed at $${path.join('')} — the ` +
      'value contains itself, so it has no serialization and cannot become a journal key. ' +
      '(JSON.stringify reports the same input as "Converting circular structure to JSON".)',
  );
}

/** Recurse into a child, remembering the step for the error path above. */
function descend(state: Descent, segment: string, value: unknown, key: string): unknown {
  state.path.push(segment);
  try {
    return sortKeys(value, key, state);
  } finally {
    state.path.pop();
  }
}

/**
 * `key` mirrors the property name `JSON.stringify` passes to `toJSON` (`''` at the root, the property
 * name inside an object, the index inside an array). It is threaded through purely so that honoring
 * `toJSON` below does not change what an existing `toJSON(key)` implementation observes. Map/Set
 * members have no JSON property name and get `''`.
 *
 * `state` defaults to a fresh descent, so `stableStringify` (and any other caller) keeps its
 * single-argument shape and two concurrent walks cannot see each other's bookkeeping.
 */
function sortKeys(value: unknown, key = '', state: Descent = { open: new Set(), path: [] }): unknown {
  // BigInt first: it is a primitive (`typeof 'bigint'`), never reaches the object branch, and made
  // `JSON.stringify` THROW outright. Serialized as a decimal string, tagged so it can't be confused
  // with the plain string "123".
  if (typeof value === 'bigint') return tagged('BigInt', value.toString());
  // TWO STRINGS UNICODE CALLS EQUAL. `José` written as one code point and `José` written as `e` plus
  // a combining acute are CANONICALLY EQUIVALENT — the same text by Unicode's own definition, and
  // indistinguishable on screen. They are different byte sequences, so they hashed differently, and
  // `idempotency: 'args'` is a promise about the same WORK: measured with a real tool, the same
  // customer arriving from a web form (NFC) and from an iOS client (NFD) was charged TWICE.
  //
  // NFC and not NFD because it is the shorter form and what the web platform already normalizes to
  // (WHATWG requires it for form submission). This is deliberately NOT case folding or trimming —
  // `José` and `JOSÉ` are different text and must stay different keys. Only forms Unicode itself
  // declares to be the same character are collapsed.
  if (typeof value === 'string') return value.normalize('NFC');
  // NaN, Infinity and -Infinity all serialize to `null` in JSON — and so does `null`. Four distinct
  // values, one journal key: a tool called with `{amount: Infinity}` would be answered from the
  // journal entry written by `{amount: NaN}`, having never run. Neither is a valid charge, but the
  // engine's contract is that different arguments are different work; silently merging them hides an
  // upstream division by zero instead of letting it surface as its own failed call.
  if (typeof value === 'number' && !Number.isFinite(value)) return tagged('Number', String(value));
  if (value && typeof value === 'object') {
    // The ONE place a cycle can close: every recursive branch below reaches its children through
    // `sortKeys`, so guarding the entrance covers objects, arrays, Map keys AND values, Set members
    // and the `toJSON` result in a single check — rather than five checks that could each be
    // forgotten. Marked open for the duration of the descent only; see `Descent` for why the unwind
    // is what separates a cycle from a shared reference.
    if (state.open.has(value)) throw circularReference(state.path);
    state.open.add(value);
    try {
      return normalizeObject(value, key, state);
    } finally {
      state.open.delete(value);
    }
  }
  return value;
}

/**
 * The object branch of `sortKeys`, split out so the cycle guard above owns the enter/leave pair in
 * one `try`/`finally` instead of having to be repeated before each of the returns below.
 *
 * Every recursive step goes through `descend`, which does exactly what the bare `sortKeys` call it
 * replaced did, plus record one path segment for the error message.
 */
function normalizeObject(value: object, key: string, state: Descent): unknown {
  // The built-ins below must be tested BEFORE the generic object branch — that branch is exactly
  // what used to flatten them to `{}`. They must also be tested BEFORE the `toJSON` branch: `Date`
  // carries its own `toJSON`, and deferring to it would emit a bare ISO string, re-colliding a Date
  // with the string that spells it — the very distinction this tagging exists to create.
  if (value instanceof Date) {
    // An invalid Date has no ISO form (`toISOString` throws); give it its own stable token instead
    // of letting the hash blow up.
    const time = value.getTime();
    return tagged('Date', Number.isNaN(time) ? 'Invalid Date' : value.toISOString());
  }
  if (value instanceof RegExp) return tagged('RegExp', [value.source, value.flags]);
  if (value instanceof URL) return tagged('URL', value.href);
  if (value instanceof URLSearchParams) {
    // Same flattening bug as URL, same fix — leaving it out was an inconsistency, not a decision:
    // `new URLSearchParams('a=1')` and `('a=2')` both hashed as `{}`, so a tool called with two
    // different query sets deduplicated into one billable call. Order and duplicate keys are
    // PRESERVED (not sorted): `a=1&a=2` and `a=2&a=1` are different query strings, and `URL` above
    // already commits to order by hashing `href`.
    return tagged('URLSearchParams', [...value].map(([k, v]) => [k, v]));
  }
  if (value instanceof Map) {
    // Insertion order must NOT matter (same reason object keys are sorted), so pairs are sorted by
    // their serialized key, with the value as a tie-break for distinct keys that serialize alike.
    const entries = [...value.entries()].map(
      ([k, v], i) =>
        [
          descend(state, `<Map key ${i}>`, k, ''),
          descend(state, `<Map value ${i}>`, v, ''),
        ] as const,
    );
    entries.sort((a, b) => {
      const byKey = compareTokens(sortToken(a[0]), sortToken(b[0]));
      return byKey !== 0 ? byKey : compareTokens(sortToken(a[1]), sortToken(b[1]));
    });
    return tagged('Map', entries.map(([k, v]) => [k, v]));
  }
  if (value instanceof Set) {
    // KNOWN RESIDUE, same class as the `toJSON` note below: a member that serializes to `undefined`
    // (undefined itself, a function, a symbol) lands in the array as JSON `null`, so `Set([undefined])`
    // and `Set([null])` share a hash — likewise a Map VALUE of those kinds. Unreachable from the wire
    // (`JSON.parse` cannot produce them); accepted rather than fixed because the golden vectors are a
    // contract and re-keying recorded hashes is the larger harm.
    const members = [...value].map((member, i) => descend(state, `<Set member ${i}>`, member, ''));
    members.sort((a, b) => compareTokens(sortToken(a), sortToken(b)));
    return tagged('Set', members);
  }
  // `toJSON` is honored EXPLICITLY rather than being left to the final `JSON.stringify`.
  //
  // WHY: the generic branch below copies own enumerable keys, and `toJSON` normally lives on the
  // PROTOTYPE — so it never made it onto the copy and was silently dropped. A class whose state is
  // private and exposed only through `toJSON` therefore collapsed to `{}`, and two instances with
  // different state shared one hash (measured). That is the same collapse-to-`{}` defect the type
  // tags above exist to fix, reached from a different direction; `JSON.stringify` would have
  // distinguished them. Calling `toJSON` here restores JSON's own semantics and, because the result
  // is re-normalized by `sortKeys`, any tag-shaped key it returns gets ESCAPED — which also closes
  // the impersonation hole that `escapeKey` alone could not reach.
  //
  // RESIDUE, stated honestly: `toJSON` REPLACES the object, so `{ toJSON: () => 1, secret: 'A' }`
  // and `{ toJSON: () => 1, secret: 'B' }` still share a hash. That is not a defect of this code —
  // it is what `toJSON` means everywhere in JavaScript, and a caller that defines it is asking for
  // exactly that identity. It is also unreachable from the wire: producing it requires a callable
  // property, and `JSON.parse` can never produce one (measured).
  //
  // One behavior follows from delegating and is accepted deliberately: a `toJSON` that throws
  // propagates (it did too whenever it was an own property, and `JSON.stringify` throws as well).
  //
  // Because the RESULT is re-normalized, a `toJSON` returning `this` would recurse forever with no
  // circular data anywhere — it used to end in a stack overflow. `value` is already open at this
  // point, so the guard in `sortKeys` catches it as the cycle it effectively is. That is a
  // deliberate divergence from `JSON.stringify`, which consults `toJSON` only once and quietly
  // yields `{}`; here the object never resolves to anything, and inventing a hash for it would mean
  // inventing a journal key.
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    return descend(state, '.toJSON()', (toJSON as (k: string) => unknown).call(value, key), key);
  }
  // Arrays are checked after `toJSON` for parity with `JSON.stringify`, which consults `toJSON`
  // first; an array without one — every array in plain JSON — is unaffected.
  if (Array.isArray(value)) {
    return value.map((item, index) => descend(state, `[${index}]`, item, String(index)));
  }
  const obj = value as Record<string, unknown>;
  // Sorting on the ESCAPED key keeps ordering deterministic; for every key that does not start
  // with NUL the escape is the identity, so this stays byte-identical to the previous `.sort()`.
  // The ORIGINAL key is what gets handed to a nested `toJSON`, matching `JSON.stringify`.
  //
  // KEYS ARE NORMALIZED TOO, for the reason string VALUES are (see `sortKeys`): a key is a string a
  // caller supplies, and in a `Record<string, unknown>` argument it is often the user's own data —
  // `{ metadata: { 'müşteri-adı': … } }`. Two canonically equivalent keys are the same key, and
  // hashing them apart would split one piece of work in two.
  //
  // Normalizing can make two DISTINCT keys collide, and the later one then wins — but only when
  // Unicode already says they are the same text, which is the same judgement the values rely on.
  // Applied before escaping so the NUL-prefix defence still sees the final byte sequence.
  return Object.keys(obj)
    .map((k) => [escapeKey(k.normalize('NFC')), k] as const)
    .sort((a, b) => compareTokens(a[0], b[0]))
    .reduce<Record<string, unknown>>((acc, [escaped, original]) => {
      acc[escaped] = descend(state, `.${original}`, obj[original], original);
      return acc;
    }, {});
}

/**
 * A value JSON cannot represent has no serialization to hash. `undefined` is the one such value that
 * is a legitimate argument — it is what "this tool takes no arguments" looks like — so it gets its
 * own token, in the tag namespace so it cannot be spelled by any real JSON output. Functions and
 * symbols are caller mistakes and say so, instead of surfacing as `The "data" argument must be of
 * type string...` from `createHash`. Nothing here can break compatibility: every one of these inputs
 * threw before, so no journal record was ever written under them.
 */
function serializeForHash(args: unknown): string {
  const serialized = stableStringify(args) as string | undefined;
  if (serialized !== undefined) return serialized;
  if (args === undefined) return `${TAG}undefined`;
  throw new TypeError(
    `argsHash: a value of type "${typeof args}" has no JSON representation and cannot be hashed.`,
  );
}

/** Secondary integrity signature of tool arguments (the primary key is toolCallId). */
export function argsHash(args: unknown): string {
  return createHash('sha256').update(serializeForHash(args)).digest('hex').slice(0, 16);
}

/**
 * The fingerprint frozen into `:input.hash` — what "one runId carries one request" is checked against.
 *
 * THREE fields exactly, named rather than spread, because the hash is a promise about the REQUEST and
 * a run object carries far more than a request (tools, limits, a model handle). Adding a field here
 * invalidates every fingerprint already in every journal, so the shape is pinned in one place instead
 * of being retyped at each call site.
 *
 * There were two call sites (`runDurableInner`, `streamDurableInner`) and then a third arrived that
 * needed the same answer and could not reach it: `rolloverRun` writes the next period's `:input`
 * DIRECTLY, and `persistInput` — which is where the hash used to be attached — never runs for a key
 * that is already filled. A seed with no `hash` is a run with no fingerprint, permanently, and inside
 * `run1_` the fingerprint check is the unconditional one. So the formula became a function.
 */
export function rawInputFingerprint(input: { prompt?: unknown; messages?: unknown; system?: unknown }): string {
  return argsHash({ prompt: input.prompt, messages: input.messages, system: input.system });
}

/**
 * Domain separation tag for the run-identity derivation, and the reason `run1_` can ever become
 * `run2_` without a migration.
 *
 * The tag is HASHED, not pasted on. Prefixing the output (`'run1_' + sha256(...)`) would look the
 * same in a log and be a different thing entirely: two formula generations would then share their
 * input space, so an id minted by v1 and an id minted by v2 could land on the same 32 hex digits and
 * one would silently read the other's journal. With the tag inside the tuple the two generations are
 * disjoint by construction, and old records stay readable while new ones are written — which is the
 * whole point of the version marker (§3).
 *
 * The bill for skipping this is documented rather than imagined: git's SHA-1→SHA-256 transition is
 * in its sixth year, argo-rollouts took a production outage from an unversioned `ComputeHash`
 * change, and Kubernetes could not widen its FNV-32 and carries a permanent `collisionCount` scar in
 * its API for it.
 */
export const WORKKEY_DST = 'gnl.run.v1';

/**
 * Which address a `workKey` is unique WITHIN. `'resource'` scopes a job to the user/resource that
 * owns it; `'org'` is for work that belongs to the installation rather than to a person (a nightly
 * reconciliation, a scheduled sweep) and must run once no matter who triggers it.
 *
 * The kind is a HASHED FIELD, not a lookup hint, because the asymmetry of getting it wrong is the
 * asymmetry the design is built around (§6): a wrong `'resource'` is noisy and cheap (the job runs
 * twice), a wrong `'org'` is silent and dangerous (one tenant is handed another tenant's answer).
 * Hashing it means the two choices can never name the same run even by accident.
 */
export type WorkScopeKind = 'resource' | 'org';

/**
 * The address itself: WHICH kind of scope, and WHICH one of them.
 *
 * Kept as a pair rather than two loose fields because the two halves are only meaningful together —
 * `'resource'` without a resourceId is not a narrower scope, it is an unanswered question (§6 makes
 * that combination a throw at the gate, package #3), and `'org'` on an org-less installation carries
 * the `'~deployment'` sentinel as its value rather than nothing (§10.2). A caller that can pass one
 * half without the other is a caller who can leave the pair half-stated in the journal.
 */
export interface WorkScope {
  kind: WorkScopeKind;
  /** resourceId | orgId | the `'~deployment'` sentinel for an installation-wide job. */
  value: string;
}

/**
 * The address of work that belongs to the INSTALLATION rather than to a person or an organization.
 *
 * `workScope: 'org'` on a deployment that has no organizations configured is not a mistake — a
 * single-tenant install is a legitimate main case (the project's own production rig is one), and
 * throwing there would refuse the very jobs the org scope exists for: the nightly reconciliation, the
 * cron that must run once. So the scope resolves to the deployment as a whole (§10.2).
 *
 * The `~` is the point of the spelling: `assertResourceId` does not admit it, so no real resourceId or
 * orgId can ever collide with this sentinel — an installation-wide job and a user called
 * '~deployment' cannot become the same address. And it is not silent: the value is written into the
 * run's `:input` record as the scope's `value`, so "which address did this actually run under?" is a
 * question the journal answers rather than a rule the reader has to remember.
 */
export const DEPLOYMENT_SCOPE = '~deployment';

/**
 * A workKey reduced to something safe to keep after the run is gone: 16 hex of sha256 over the text.
 *
 * Where it goes (§8, third rule): tombstones, the conflict ledger, logs and telemetry — every place
 * whose whole point is outliving the record it describes. What it is FOR is diagnosis ("the swept run
 * was named something", "these two refusals were the same job"), never lookup: nothing resolves a
 * hash back to a run, and the matching the engine does uses `workDigest`, which is a different
 * function with a different budget (32 hex, and an agent/scope tuple around it).
 *
 * 16 hex is enough precisely because nothing routes on it. And the honest half, which belongs next to
 * every use: this is a PSEUDONYM, not an anonymisation. sha256 is offline-computable, so a
 * low-entropy workKey ('invoice-4471') is recoverable by dictionary and keeps its personal-data
 * status under GDPR. What the hash buys is that a deletion no longer leaves the caller's business
 * string sitting in a marker that outlives it (§10.3).
 */
export function workKeyHash(workKey: string): string {
  return createHash('sha256').update(workKey).digest('hex').slice(0, 16);
}

/** A `workKey` is a business name, not a payload; past this length it is neither. */
const MAX_WORK_KEY_LENGTH = 2048;

/** The engine's namespace on the raw runId surface. Generation 1 of the formula above. */
export const DERIVED_RUN_ID_PREFIX = 'run1_';

/**
 * The complete spelling of an engine-derived id: the prefix, 32 lowercase hex, and — optionally —
 * ONE execution-axis suffix.
 *
 * `#<n>` starts at 2 and carries no leading zero (`[2-9]\d*` covers 2..9 and anything opening with
 * 2-9; `[1-9]\d+` covers 10..19 and the rest), because execution #1 IS the bare id — a `#1` spelling
 * would be a second name for a run that already has one, and two names for one journal prefix is the
 * bug class this whole file exists to close. `#replay-<seq>` is the regression path's counter, a
 * DETERMINISTIC integer rather than the wall clock the old `:replay:${Date.now()}` buried in an id
 * (§4) — timestamps in an identity kill replay, and replay is what durability means here.
 * `#fork-<n>` is the third and last suffix: `forkRun`'s "re-run from here" copy, counted from 1
 * because — unlike an execution number — a fork is never the base run, so there is no fork #0 to
 * clash with the bare id.
 *
 * NO LEADING ZEROS anywhere, and that applies to `replay-` too (`0|[1-9]\d*`, not `\d+`). A suffix
 * is read back with `Number()`, so `#replay-01` and `#replay-1` would be two spellings of one
 * identity — the same "two names for one journal prefix" hazard as `#1`, arriving through a
 * different door. The engine never mints a padded number; refusing the padded spelling is what keeps
 * that a property instead of a habit.
 *
 * Note this is a full-string match: `run1_<32hex>#2#3` and `run1_<32hex>:child` do not pass. Inside
 * this namespace the engine owns the shape completely, so anything it did not mint is refused rather
 * than tolerated.
 */
const DERIVED_RUN_ID_RE =
  /^run1_([0-9a-f]{32})(?:#(?:([2-9]\d*|[1-9]\d+)|replay-(0|[1-9]\d*)|fork-([1-9]\d*)))?$/;

/** True for an id the engine could have minted — prefix, digest and at most one axis suffix. */
export function isDerivedRunId(runId: string): boolean {
  return DERIVED_RUN_ID_RE.test(runId);
}

function rejectEmpty(field: string, value: unknown, why: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`@gnldev/durable: ${field} must be a non-empty string — ${why}`);
  }
}

/**
 * The identity of a unit of work: 32 hex characters derived from the tuple the decision pins (§3).
 *
 *     sha256(stableStringify([WORKKEY_DST, agentName, scopeKind, scopeValue, workKey])).slice(0, 32)
 *
 * WHY A TUPLE AND NOT A CONCATENATION. `scope + workKey` is not injective: `("a","b:c")` and
 * `("a:b","c")` are two different pairs that produce one byte string and therefore one identity. A
 * caller who can choose either half can walk a boundary until it lands on someone else's address.
 * That is not a thought experiment — it shipped twice in 2026 (CVE-2026-76581, CVSS 9.8, an
 * unauthenticated admin session through a shifted boundary; CVE-2026-71326, whose official fix note
 * is the phrase "length prefix"). The standard answer is NIST SP 800-185's TupleHash: length prefix
 * per field, plus arity, plus a domain tag.
 *
 * We do not take a SHA-3 dependency for it, because `stableStringify` already IS an injective tuple
 * encoding: a JSON array delimits every element and escapes every delimiter that could appear inside
 * one, so the pair above serializes as `["a","b:c"]` vs `["a:b","c"]` — different bytes, permanently.
 * The `workKey swallows the separator` case in the test file is the check that this escaping, not
 * luck, is doing the work.
 *
 * WHY 32 HEX AND NOT THE 16 `argsHash` USES. Different risk class, different budget, and this is the
 * line the next reader will be tempted to "tidy up". `argsHash` truncates to 16 because its
 * collision window is one dedup decision inside one run, observed by one caller. A runId collision
 * is identity theft: two tenants' journals answering to one key. At 128 bits, ten years of a billion
 * runs a year sits around 1.5×10⁻¹⁹; at 64 bits the same traffic is a coin flip. And a hash you
 * cannot widen later is a permanent scar, not an inconvenience — Kubernetes proved that with FNV-32
 * (#43449), where the collision could not be engineered away and the API grew a `collisionCount`
 * field instead. Truncating this is minting `run2_`, and every stored run moves.
 *
 * Throws for inputs that are not names. `scopeValue` has no default here on purpose: an org-less
 * installation using `workScope: 'org'` passes the `'~deployment'` sentinel in from the CALLER (§10.2)
 * so the choice shows up as a row in the protection matrix, instead of being invented inside a hash
 * function where nobody can see it.
 */
export function workDigest(
  agentName: string,
  scopeKind: WorkScopeKind,
  scopeValue: string,
  workKey: string,
): string {
  rejectEmpty('agentName', agentName, 'the agent name is part of a run identity (renaming an agent starts a new identity for its unfinished work).');
  rejectEmpty('scopeValue', scopeValue, "it is the address a workKey is unique within — pass the resourceId, the orgId, or the '~deployment' sentinel for an installation-wide job.");
  rejectEmpty('workKey', workKey, 'it is your name for the unit of work (the invoice being issued, tonight\'s reconciliation).');
  if (workKey.length > MAX_WORK_KEY_LENGTH) {
    throw new Error(
      `@gnldev/durable: workKey is too long (${workKey.length} > ${MAX_WORK_KEY_LENGTH}) — a workKey is ` +
        'the NAME for work, not the work itself. If you are hashing a payload into it, hash it on your ' +
        'side and pass the digest.',
    );
  }
  return createHash('sha256')
    .update(stableStringify([WORKKEY_DST, agentName, scopeKind, scopeValue, workKey]))
    .digest('hex')
    .slice(0, 32);
}

/**
 * `workDigest` behind the engine's namespace — the id a derived run actually gets.
 *
 * This is execution #1 by definition; there is no `#1` spelling (see `DERIVED_RUN_ID_RE`). The id is
 * opaque, and honestly so: it is a stable PSEUDONYM for the caller's workKey, not an anonymisation of
 * it. sha256 is offline-computable, so a low-entropy workKey can be recovered by dictionary. What
 * stops "guess an id and read it" is the ownership gate, not the hash (§11) — unguessability is
 * defense in depth here, never the primary defense.
 */
export function derivedRunId(
  agentName: string,
  scopeKind: WorkScopeKind,
  scopeValue: string,
  workKey: string,
): string {
  return DERIVED_RUN_ID_PREFIX + workDigest(agentName, scopeKind, scopeValue, workKey);
}

/**
 * The deliberate second (third, fourth…) run of the SAME work: `run1_<digest>#<n>`, n ≥ 2.
 *
 * Rerunning is not an edge case — 3.2% of GitHub Actions workflow runs are reruns (ACM measurement),
 * which is why "run this again on purpose" gets a first-class spelling instead of forcing callers to
 * mangle the workKey. A base that already carries an axis is refused rather than extended: `#2#3` has
 * no meaning, and quietly accepting it would produce an id `assertRunIdSafe` then rejects downstream.
 *
 * PURE. Nothing here reads or writes a journal, so nothing here knows whether `#2` is free. Choosing
 * the next free n (the rollover/replay migration off `@N` and `:replay:<timestamp>:`) is a later
 * package; this is only the spelling.
 */
export function executionRunId(base: string, n: number): string {
  if (typeof base !== 'string' || base.includes('#')) {
    throw new Error(
      `@gnldev/durable: executionRunId got a base that already carries the '#' execution axis ('${String(base).slice(0, 60)}') — ` +
        'an id has one execution number, not a chain of them.',
    );
  }
  if (!isDerivedRunId(base)) {
    throw new Error(
      `@gnldev/durable: executionRunId got '${base.slice(0, 60)}', which is not an engine-derived id — ` +
        "the '#' axis exists only inside the run1_ namespace.",
    );
  }
  if (!Number.isInteger(n) || n < 2) {
    throw new Error(
      `@gnldev/durable: execution number must be an integer ≥ 2 (got ${n}) — execution #1 is the base id itself.`,
    );
  }
  return `${base}#${n}`;
}

/**
 * The "re-run from HERE" sibling of an engine-derived run: `run1_<digest>#fork-<n>`, n ≥ 1.
 *
 * `forkRun`'s old default target was `${srcRunId}:fork:${Date.now()}` — two separate violations for a
 * derived source. It buried the wall clock in an identity (§11's explicit ban: an id that changes on
 * every call cannot be replayed to), and it wore the `run1_` prefix without the shape, which
 * `assertRunIdSafe` now refuses outright. So a derived fork gets a counted suffix instead, and the
 * counting happens where the journal can be read (time-travel.ts), not here.
 *
 * Counting from 1 rather than 2: `#<n>` starts at 2 because execution #1 already has a name (the bare
 * id). A fork has no such twin — the base run is not "fork #0" of itself — so 1 is the first fork and
 * `#fork-0` is refused.
 *
 * PURE, and refusing a suffixed base for the same reason `executionRunId` does: one id carries one
 * suffix. `run1_<d>#2#fork-1` would be a chain, and the honest consequence — a fork of the second
 * execution is named off the shared BASE, so the id alone no longer says which execution it came
 * from — is stated at the call site that has to live with it (`forkRun`).
 */
export function forkRunId(base: string, n: number): string {
  if (typeof base !== 'string' || base.includes('#')) {
    throw new Error(
      `@gnldev/durable: forkRunId got a base that already carries the '#' execution axis ('${String(base).slice(0, 60)}') — ` +
        'an id carries one suffix, not a chain of them.',
    );
  }
  if (!isDerivedRunId(base)) {
    throw new Error(
      `@gnldev/durable: forkRunId got '${base.slice(0, 60)}', which is not an engine-derived id — ` +
        "the '#' axis exists only inside the run1_ namespace (a raw runId forks as '<id>:fork:<n>').",
    );
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `@gnldev/durable: fork number must be an integer ≥ 1 (got ${n}) — the base run is not fork #0 of itself.`,
    );
  }
  return `${base}#fork-${n}`;
}

/** What an engine-derived id says about itself, once it is read back apart. */
export interface DerivedRunIdParts {
  /** The 32 hex characters of `workDigest`. Not reversible to the workKey — that mapping is stored. */
  digest: string;
  /** Present from the second deliberate execution onwards; absent means execution #1. */
  execution?: number;
  /** Present on a regression replay: the deterministic counter behind `#replay-<seq>`. */
  replaySeq?: number;
  /** Present on a `forkRun` copy: the deterministic counter behind `#fork-<n>`, from 1. */
  fork?: number;
}

/**
 * The id WITHOUT its execution-axis suffix — `run1_<digest>` for every spelling in the namespace.
 *
 * The three minting sites (fork, rollover, replay) all need the same first move: given an id that may
 * already carry a suffix, find the base the suffix counts against. Doing it by hand is doing
 * `slice(0, indexOf('#'))` in three files, and the fourth site is where it gets done wrong.
 *
 * Returns `undefined` for anything outside the namespace — a raw runId has no base because it has no
 * axis, and the callers branch on exactly that.
 */
export function derivedRunIdBase(runId: string): string | undefined {
  const parts = parseDerivedRunId(runId);
  return parts ? DERIVED_RUN_ID_PREFIX + parts.digest : undefined;
}

/**
 * Reads an id the engine minted; returns `undefined` for everything else — including ids that merely
 * look derived (`run1_deadbeef`) and the spellings the axis forbids (`#1`, `#0`, `#x`).
 *
 * `undefined` rather than a throw because every caller of this is asking a QUESTION ("is this one of
 * ours?") about an id that legitimately might not be. The refusal of a lookalike belongs on the write
 * path, and lives there: `assertRunIdSafe`.
 */
export function parseDerivedRunId(runId: string): DerivedRunIdParts | undefined {
  if (typeof runId !== 'string') return undefined;
  const m = DERIVED_RUN_ID_RE.exec(runId);
  if (!m) return undefined;
  const parts: DerivedRunIdParts = { digest: m[1]! };
  if (m[2] !== undefined) parts.execution = Number(m[2]);
  if (m[3] !== undefined) parts.replaySeq = Number(m[3]);
  if (m[4] !== undefined) parts.fork = Number(m[4]);
  return parts;
}

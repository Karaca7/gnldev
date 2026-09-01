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
  return Object.keys(obj)
    .map((k) => [escapeKey(k), k] as const)
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

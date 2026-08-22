// A reserved key inherited from a polluted `Object.prototype`.
//
// `delete` removes an OWN property only, so a reserved key on the prototype survives the seal and
// reads back exactly like a value the server set. The seal now shadows it with an own `undefined`,
// and only when the key is still reachable, so an ordinary context gains nothing.
//
// gnl's own callers cannot reach this — a JSON body gives `__proto__` as an own DATA property and
// object spread copies it as data, so `Object.prototype` is untouched. But `sealRequestContext` is
// exported from this package's public entry point, and a YAML parse, a query-string parser or a
// config merge has no such property.
//
// TWO GROUPS BELOW, AND THE SPLIT IS THE POINT. The first passes and pins what the shadowing achieves.
// The second FAILS and is reported: the shadow is written with an ASSIGNMENT, and an assignment walks
// the prototype chain. An inherited accessor swallows it; an inherited getter-only or non-writable
// data property makes it throw. See the header of that describe for the measured detail.
//
// Every test restores `Object.prototype` in a `finally` AND in `afterEach` — a leaked polluted
// prototype would corrupt every other test sharing this worker, which is a far worse outcome than the
// bug being tested.
import { describe, it, expect, afterEach } from 'vitest';
import { sealRequestContext, serverIdentityOf, GNL_ORG_ID_KEY, GNL_RESOURCE_ID_KEY, GNL_THREAD_ID_KEY } from '../src/registry.js';

const RESERVED = ['org', GNL_ORG_ID_KEY, GNL_RESOURCE_ID_KEY, GNL_THREAD_ID_KEY] as const;

/** The `server` argument that supplies a value for each reserved key, and what it must produce. */
const SERVER: Record<string, { server: { orgId?: string; resourceId?: string; threadId?: string }; expect: string }> = {
  org: { server: { orgId: 'acme' }, expect: 'acme' },
  [GNL_ORG_ID_KEY]: { server: { orgId: 'acme' }, expect: 'acme' },
  [GNL_RESOURCE_ID_KEY]: { server: { resourceId: 'real-user' }, expect: 'real-user' },
  [GNL_THREAD_ID_KEY]: { server: { threadId: 'real-thread' }, expect: 'real-thread' },
};

const scrub = (): void => { for (const k of RESERVED) delete (Object.prototype as Record<string, unknown>)[k]; };
afterEach(scrub);

/** Non-enumerable by default: identical for every read the seal performs, and far safer for the runner. */
function polluteData(key: string, value: unknown, enumerable = false): void {
  Object.defineProperty(Object.prototype, key, { value, writable: true, enumerable, configurable: true });
}
function polluteAccessor(key: string, value: unknown, withSetter: boolean): void {
  const d: PropertyDescriptor = { get: () => value, configurable: true };
  if (withSetter) d.set = () => { /* silently swallows the write */ };
  Object.defineProperty(Object.prototype, key, d);
}

/**
 * Runs `fn` with the prototype polluted, and always restores it.
 *
 * `fn` must return the MEASUREMENTS, never the sealed object. Returning the object and asserting on it
 * afterwards reads it with the prototype already restored, so an unshadowed key reads `undefined` and a
 * "the pollution did not survive" assertion passes for exactly the wrong reason. Two tests in this file
 * did that before this note existed — one of them was the accessor-bypass test, i.e. the test whose
 * whole purpose was to prove the shadow is missing.
 */
function polluted<T>(pollute: () => void, fn: () => T): T {
  pollute();
  try { return fn(); } finally { scrub(); }
}

/** What a caller can observe about one key, captured while the prototype is still polluted. */
const read = (sealed: Record<string, unknown>, key: string) => ({
  value: sealed[key],
  own: Object.prototype.hasOwnProperty.call(sealed, key),
  keys: Object.keys(sealed),
});

describe('a reserved key inherited from a polluted prototype', () => {
  it.each(RESERVED)('%s does not survive the seal when the server resolved nothing', (key) => {
    const got = polluted(() => polluteData(key, 'ATTACKER'), () => read(sealRequestContext({ a: 1 }, {}), key));

    expect(got.value, 'an inherited reserved key read back as though the server had set it').toBeUndefined();
    expect(got.own, 'the key was not shadowed, so it is still being read through the prototype').toBe(true);
  });

  it.each(RESERVED)('%s: the value the server resolved still wins', (key) => {
    const { server, expect: want } = SERVER[key]!;
    const got = polluted(() => polluteData(key, 'ATTACKER'), () => read(sealRequestContext({ a: 1 }, server), key));

    expect(got.value, 'the shadowing swallowed the server-derived value it exists to protect').toBe(want);
  });

  // The realistic shape: a parser that assigns rather than defines produces an ENUMERABLE property.
  it.each(RESERVED)('%s is stripped whether the pollution is enumerable or not', (key) => {
    const enumerable = polluted(() => polluteData(key, 'ATTACKER', true), () => read(sealRequestContext({ a: 1 }, {}), key));
    const hidden = polluted(() => polluteData(key, 'ATTACKER', false), () => read(sealRequestContext({ a: 1 }, {}), key));

    expect(enumerable.value).toBeUndefined();
    expect(enumerable.own, 'the enumerable form was not shadowed').toBe(true);
    expect(hidden.value).toBeUndefined();
    expect(hidden.own, 'the non-enumerable form was not shadowed').toBe(true);
  });

  // The read-back path. A shadowed `undefined` must not be mistaken for an identity, or the seal has
  // simply moved the leak one function along.
  it('does not read back as a server identity', () => {
    const identity = polluted(
      () => { for (const k of RESERVED) polluteData(k, 'ATTACKER'); },
      () => serverIdentityOf(sealRequestContext({ a: 1 }, {})),
    );

    expect(identity, 'an inherited key was reported as the identity the server derived').toEqual({});
  });

  // The claim the production comment makes, which is where this codebase keeps being wrong.
  it('adds no key at all when the prototype is clean', () => {
    scrub();
    const sealed = sealRequestContext({ a: 1 }, {});

    expect(Object.keys(sealed), 'an ordinary context gained keys it never had').toEqual(['a']);
    for (const k of RESERVED) {
      expect(Object.prototype.hasOwnProperty.call(sealed, k), `an own \`${k}\` was invented`).toBe(false);
      expect(k in sealed).toBe(false);
    }
    expect(JSON.stringify(sealed)).toBe('{"a":1}');
  });

  // A JSON body is the shape gnl's own callers actually hand over. It must not pollute, and must not
  // trip the shadowing either.
  it('is not reachable from a JSON request body', () => {
    scrub();
    const body = JSON.parse('{"__proto__":{"org":"ATTACKER"},"a":1}');
    const sealed = sealRequestContext(body, {});

    expect(({} as Record<string, unknown>).org, 'parsing a request body polluted Object.prototype').toBeUndefined();
    expect(Object.getPrototypeOf(sealed), 'the seal changed the object\'s prototype').toBe(Object.prototype);
    expect(sealed.org).toBeUndefined();
    expect(sealed.a).toBe(1);
    // This assertion used to read `.toBe(true)`, recording that the spread carried `__proto__` onward
    // as an inert own data property and calling the consequence "a property of the consumer, not of
    // the seal". Measuring that consequence showed it is not something to hand on: `Object.assign`
    // writes with [[Set]], so the ordinary one-line merge re-arms the payload —
    //
    //   Object.assign({}, sealed).isAdmin -> true, and the target's prototype is now the attacker's
    //
    // — and this context is handed to user-written dynamic `system`/`model`/`tools` functions. The
    // seal now drops the key, so the assertion is inverted rather than relaxed.
    expect(Object.prototype.hasOwnProperty.call(sealed, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf({ ...sealed })).toBe(Object.prototype);
  });

  it('does not hand a downstream Object.assign a live prototype payload', () => {
    scrub();
    const sealed = sealRequestContext(JSON.parse('{"a":1,"__proto__":{"isAdmin":true}}'), { orgId: 'acme' });
    const merged = Object.assign({}, sealed) as Record<string, unknown>;

    expect(merged.isAdmin, 'a merged sealed context granted a property the body invented').toBeUndefined();
    expect(Object.getPrototypeOf(merged), 'merging a sealed context set a prototype').toBe(Object.prototype);
    expect(merged.org, 'the merge lost the server-derived org').toBe('acme');
    expect(merged.a).toBe(1);
  });
});

describe('input objects the seal must keep accepting', () => {
  // The shadowing must not have made ordinary-but-exotic inputs throw or behave differently. These are
  // OWN-property shapes: none of them involve the prototype, so all four must simply be stripped.
  it.each([
    ['frozen', () => Object.freeze({ org: 'victim', a: 1 })],
    ['null-prototype', () => Object.assign(Object.create(null), { org: 'victim', a: 1 })],
    ['non-configurable own key', () => Object.defineProperty({ a: 1 }, 'org', { value: 'victim', enumerable: true, configurable: false })],
    ['an own getter', () => Object.defineProperty({ a: 1 }, 'org', { get: () => 'victim', enumerable: true, configurable: true })],
  ])('%s', (_label, make) => {
    scrub();
    const sealed = sealRequestContext(make() as Record<string, unknown>, {});

    expect(sealed.org, 'a client-supplied org survived in an exotic input shape').toBeUndefined();
    expect(Object.keys(sealed)).toEqual(['a']);
  });
});

/**
 * REPORTED FAILURES — the shadowing is written with an ASSIGNMENT, and `sealed[k] = undefined`
 * performs a [[Set]], which walks the prototype chain before it creates an own property.
 *
 * Measured against the current implementation:
 *
 *   accessor pair on prototype      sealed.org = "PWNED"   (own key never created)
 *   accessor pair + server="acme"   sealed.org = "PWNED"   (the SERVER's value is discarded too)
 *   getter-only on prototype        TypeError: Cannot set property org of #<Object> which has only a getter
 *   non-writable data on prototype  TypeError: Cannot assign to read only property 'org'
 *
 * The second line is the serious one and it is NOT introduced by the shadowing: `sealed[GNL_RESOURCE_ID_KEY]
 * = server.resourceId` is an assignment too, so an inherited setter swallows the server-derived identity
 * and the attacker's getter wins — the original P1.7 hijack class, reachable again. Measured:
 * `sealRequestContext({a:1}, { resourceId: 'real-user' })` returns `__gnl_resourceId = "victim-user"`.
 *
 * `Object.defineProperty(sealed, k, { value, writable: true, enumerable: true, configurable: true })`
 * defines on the object itself and never consults the prototype, which fixes all eight cells and keeps
 * the "adds no key when clean" property. Verified in simulation; not applied — production is not mine.
 */
describe('prototype pollution the shadowing does not stop', () => {
  it('an inherited accessor pair still reaches the caller', () => {
    const got = polluted(() => polluteAccessor('org', 'PWNED', true), () => read(sealRequestContext({ a: 1 }, {}), 'org'));

    expect(got.own, 'no own property was created, so the prototype still answers for this key').toBe(true);
    expect(got.value, 'the inherited setter swallowed the shadow, so the polluted getter still answers').toBeUndefined();
  });

  it('an inherited accessor pair does not override the value the server resolved', () => {
    const got = polluted(
      () => polluteAccessor(GNL_RESOURCE_ID_KEY, 'victim-user', true),
      () => read(sealRequestContext({ a: 1 }, { resourceId: 'real-user' }), GNL_RESOURCE_ID_KEY),
    );

    expect(got.value,
      'the server-derived identity was discarded and a prototype value answered in its place').toBe('real-user');
  });

  it('an inherited getter with no setter does not make the seal throw', () => {
    expect(() => polluted(() => polluteAccessor('org', 'PWNED', false), () => sealRequestContext({ a: 1 }, {})))
      .not.toThrow();
  });

  it('an inherited non-writable data property does not make the seal throw', () => {
    expect(() => polluted(
      () => Object.defineProperty(Object.prototype, 'org', { value: 'PWNED', writable: false, configurable: true }),
      () => sealRequestContext({ a: 1 }, {}),
    )).not.toThrow();
  });
});

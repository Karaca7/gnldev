// The seal's two structural claims, attacked directly.
//
//   1. every write in `sealRequestContext` goes through `defineProperty`, so no polluted prototype can
//      influence the result — for ANY reserved key, ANY pollution shape, with or without a server value;
//   2. the sealed context is safe for a consumer to MERGE, because `__proto__` is dropped.
//
// Claim 2 needs a reason to stop where it stops, and that reason is structural rather than a list:
// `__proto__` is the only own property of `Object.prototype` that is an ACCESSOR, so it is the only key
// whose assignment has a side effect instead of creating an own property. That is asserted below rather
// than asserted about, because "we handled the dangerous key" is exactly the kind of claim this codebase
// keeps getting wrong by enumeration.
//
// KNOWN RESIDUAL, pinned at the bottom: the strip is SHALLOW. A `__proto__` nested inside a context
// value survives, and no serialization step removes it. That is a boundary, not a guarantee — the tests
// naming it say so.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import {
  createGnl, sealRequestContext, serverIdentityOf,
  GNL_ORG_ID_KEY, GNL_RESOURCE_ID_KEY, GNL_THREAD_ID_KEY,
} from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

const RESERVED = ['org', GNL_ORG_ID_KEY, GNL_RESOURCE_ID_KEY, GNL_THREAD_ID_KEY] as const;
const SERVER: Record<string, { server: { orgId?: string; resourceId?: string; threadId?: string }; want: string }> = {
  org: { server: { orgId: 'acme' }, want: 'acme' },
  [GNL_ORG_ID_KEY]: { server: { orgId: 'acme' }, want: 'acme' },
  [GNL_RESOURCE_ID_KEY]: { server: { resourceId: 'real-user' }, want: 'real-user' },
  [GNL_THREAD_ID_KEY]: { server: { threadId: 'real-thread' }, want: 'real-thread' },
};

const scrub = (): void => { for (const k of RESERVED) delete (Object.prototype as Record<string, unknown>)[k]; };
afterEach(scrub);

/** The four ways a reserved key can sit on a polluted prototype. Only the first was ever survivable. */
const SHAPES: Record<string, (k: string) => void> = {
  'data property': (k) => Object.defineProperty(Object.prototype, k, { value: 'PWNED', writable: true, configurable: true }),
  'getter-only': (k) => Object.defineProperty(Object.prototype, k, { get: () => 'PWNED', configurable: true }),
  'accessor pair': (k) => Object.defineProperty(Object.prototype, k, { get: () => 'PWNED', set: () => { /* swallows */ }, configurable: true }),
  'non-writable data': (k) => Object.defineProperty(Object.prototype, k, { value: 'PWNED', writable: false, configurable: true }),
};

/** Measurements taken while the prototype is STILL polluted — see the note in the sibling file. */
function measure(key: string, server: object): { value: unknown; own: boolean; identity: unknown } {
  const sealed = sealRequestContext({ a: 1 }, server as never);
  return {
    value: sealed[key],
    own: Object.prototype.hasOwnProperty.call(sealed, key),
    identity: serverIdentityOf(sealed),
  };
}

describe('every write in the seal ignores the prototype chain', () => {
  // 4 shapes x 4 reserved keys x {server value, no server value}. The point of the full cross-product
  // is that the four shapes must be INDISTINGUISHABLE: an implementation that handles one of them
  // (assignment handled only the data-property row) passes a single-shape test.
  for (const [shapeName, pollute] of Object.entries(SHAPES)) {
    it.each(RESERVED)(`${shapeName} on the prototype cannot influence %s`, (key) => {
      const { server, want } = SERVER[key]!;

      pollute(key);
      let withServer: ReturnType<typeof measure>;
      let without: ReturnType<typeof measure>;
      try {
        withServer = measure(key, server);
        without = measure(key, {});
      } finally { scrub(); }

      expect(withServer.value, 'the server-derived value was discarded or replaced by a prototype value').toBe(want);
      expect(withServer.own, 'no own property was written — the key is still answered by the prototype').toBe(true);
      expect(withServer.identity, 'the identity read-back disagrees with the sealed context')
        .toEqual(Object.fromEntries(Object.entries(server)));

      expect(without.value, 'an inherited value survived when the server resolved nothing').toBeUndefined();
      expect(without.own, 'the key was not shadowed').toBe(true);
      expect(without.identity, 'a shadowed key read back as a server identity').toEqual({});
    });
  }

  // Input shapes that are hostile in a different way: the seal must neither throw nor consult them for
  // anything but their own enumerable properties.
  it.each([
    ['a prototype that is a lying Proxy', () => Object.create(new Proxy({}, {
      has: () => true, get: () => 'PWNED', ownKeys: () => ['org'],
    }))],
    ['a context that IS a Proxy', () => new Proxy({ a: 1, org: 'victim' } as Record<string, unknown>, {
      get: (t, p) => (p === 'org' ? 'PWNED' : t[p as string]),
    })],
    ['a context that throws when coerced', () => ({ a: 1, [Symbol.toPrimitive]: () => { throw new Error('coerced'); } })],
    ['a frozen context', () => Object.freeze({ a: 1, org: 'victim' })],
  ])('%s does not change the result', (_label, make) => {
    scrub();
    const sealed = sealRequestContext(make() as never, { orgId: 'acme' });

    expect(sealed.org, 'a hostile input shape decided the organization').toBe('acme');
    expect(Object.getPrototypeOf(sealed), 'the sealed object is not an ordinary object').toBe(Object.prototype);
  });
});

describe('`__proto__` is the only key that needs stripping', () => {
  // The structural justification for a one-key strip. If a future runtime adds a second accessor to
  // Object.prototype, this fails and the strip has to be revisited — which is the entire reason it is
  // asserted rather than reasoned about in a comment.
  it('because it is the only ACCESSOR own property on Object.prototype', () => {
    const accessors = Object.getOwnPropertyNames(Object.prototype)
      .filter((n) => { const d = Object.getOwnPropertyDescriptor(Object.prototype, n)!; return !!(d.get || d.set); });

    expect(accessors, 'another prototype key has [[Set]] side effects and the strip no longer covers the class')
      .toEqual(['__proto__']);
  });

  // Why the reasoning above is airtight rather than merely true today: a sealed context is always an
  // ordinary object (the spread target is `{}`), so its chain is exactly `sealed -> Object.prototype ->
  // null`, and that chain CANNOT be lengthened — `Object.prototype` is an immutable-prototype exotic
  // object. So `k in sealed` and `sealed[k] = v` can only ever consult `Object.prototype`, which is the
  // one object the accessor survey above covers.
  //
  // This also explains a mutation that SURVIVES: reverting any single server-value write from
  // `define` to assignment changes nothing, because the shadow above has already created an own
  // writable property for every reachable reserved key, and assignment finds an own property before it
  // walks anywhere. Those `define` calls are defence-in-depth whose redundancy depends entirely on the
  // shadow line staying as it is — which is why the invariant is asserted here rather than assumed.
  it('the prototype chain above a sealed context cannot be extended', () => {
    scrub();
    const sealed = sealRequestContext(Object.assign(Object.create(null), { a: 1 }) as never, {});
    expect(Object.getPrototypeOf(sealed)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(Object.prototype), 'something has already been spliced above Object.prototype').toBe(null);
    expect(() => Object.setPrototypeOf(Object.prototype, { evil: true }),
      'Object.prototype is no longer an immutable-prototype object, so a `has`/`set` trap could be spliced above every sealed context')
      .toThrow(TypeError);
  });

  // Every reachable reserved key ends up as an OWN property. This is the invariant every later write
  // relies on: an assignment that finds an own property never consults the prototype at all.
  it('leaves every reachable reserved key as an own property', () => {
    for (const k of RESERVED) {
      Object.defineProperty(Object.prototype, k, { get: () => 'PWNED', set: () => {}, configurable: true });
    }
    try {
      const sealed = sealRequestContext({ a: 1 }, {});
      for (const k of RESERVED) {
        expect(Object.prototype.hasOwnProperty.call(sealed, k), `${k} is still answered by the prototype`).toBe(true);
      }
    } finally { scrub(); }
  });

  // The consequence for the keys that are NOT accessors: a merge writes a plain own property. There is
  // no prototype hijack, so they are deliberately left alone.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    '%s rides along but cannot hijack a merged object\'s prototype', (key) => {
      scrub();
      const sealed = sealRequestContext(JSON.parse(`{"a":1,"${key}":"HIJACK"}`), {});
      const merged = Object.assign({}, sealed) as Record<string, unknown>;

      expect(Object.prototype.hasOwnProperty.call(sealed, key), 'the seal silently dropped an ordinary caller key').toBe(true);
      expect(Object.getPrototypeOf(merged), 'a data-property key hijacked the prototype after all').toBe(Object.prototype);
    });

  // ...but shadowing `toString` still breaks string coercion of the MERGED object. Not an escalation —
  // recorded because it is the one residual of leaving these keys in place, and a consumer that
  // interpolates the context into a template literal crashes on it.
  it('a `toString` key makes a merged context throw when coerced to a string', () => {
    scrub();
    const merged = Object.assign({}, sealRequestContext(JSON.parse('{"toString":"HIJACK"}'), {}));
    expect(() => String(merged)).toThrow(TypeError);
  });
});

describe('a sealed context is safe to merge', () => {
  const PAYLOAD = '{"a":1,"__proto__":{"isAdmin":true}}';

  // Six ways to put `__proto__` on the object handed to the seal. The spread that builds `sealed`
  // normalises all of them into an own DATA property, which is what the strip then removes.
  it.each([
    ['a JSON body', () => JSON.parse(PAYLOAD)],
    ['defineProperty as data', () => Object.defineProperty({ a: 1 }, '__proto__', { value: { isAdmin: true }, enumerable: true, configurable: true, writable: true })],
    ['an own accessor', () => Object.defineProperty({ a: 1 }, '__proto__', { get: () => ({ isAdmin: true }), enumerable: true, configurable: true })],
    ['a non-configurable own key', () => Object.defineProperty({ a: 1 }, '__proto__', { value: { isAdmin: true }, enumerable: true, configurable: false, writable: false })],
    ['a null-prototype context', () => { const o = Object.create(null); o.a = 1; o['__proto__'] = { isAdmin: true }; return o; }],
    ['a Proxy that reports it', () => new Proxy({ a: 1 } as Record<string, unknown>, {
      ownKeys: () => ['a', '__proto__'],
      getOwnPropertyDescriptor: (t, p) => (p === '__proto__'
        ? { value: { isAdmin: true }, enumerable: true, configurable: true, writable: true }
        : Object.getOwnPropertyDescriptor(t, p as string)),
      get: (t, p) => (p === '__proto__' ? { isAdmin: true } : t[p as string]),
    })],
  ])('%s cannot arm a prototype hijack', (_label, make) => {
    scrub();
    const sealed = sealRequestContext(make() as never, { orgId: 'acme' });

    expect(Object.prototype.hasOwnProperty.call(sealed, '__proto__'), 'the live payload was passed on to consumers').toBe(false);
    // The four ways a consumer routinely copies this object. `Object.assign` is the one that re-arms it,
    // because it writes with [[Set]] — the other three are asserted so a fix that only handles assign
    // cannot look complete.
    expect((Object.assign({}, sealed) as Record<string, unknown>).isAdmin, 'Object.assign re-armed the payload').toBeUndefined();
    expect(({ ...sealed } as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(JSON.parse(JSON.stringify(sealed)).isAdmin).toBeUndefined();
    expect((structuredClone(sealed) as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(sealed.org, 'the strip took the server-derived org with it').toBe('acme');
    expect(sealed.a, 'the strip took ordinary caller data with it').toBe(1);
  });

  it('and an ordinary context is not altered by the strip', () => {
    scrub();
    const sealed = sealRequestContext({ a: 1, nested: { b: 2 } }, {});
    expect(Object.keys(sealed)).toEqual(['a', 'nested']);
    expect(sealed.nested).toEqual({ b: 2 });
  });
});

describe('the seal is not distinguishable from the assignment it replaced', () => {
  /** The previous implementation, faithfully — the ONLY difference is assignment vs defineProperty. */
  function sealByAssignment(ctx: Record<string, unknown>, server: { resourceId?: string; orgId?: string; threadId?: string }) {
    const sealed: Record<string, unknown> = { ...ctx };
    delete sealed['__proto__'];
    for (const k of [GNL_RESOURCE_ID_KEY, GNL_ORG_ID_KEY, GNL_THREAD_ID_KEY, 'org']) {
      delete sealed[k];
      if (k in sealed) sealed[k] = undefined;
    }
    if (server.resourceId !== undefined) sealed[GNL_RESOURCE_ID_KEY] = server.resourceId;
    if (server.orgId !== undefined) { sealed[GNL_ORG_ID_KEY] = server.orgId; sealed.org = server.orgId; }
    if (server.threadId !== undefined) sealed[GNL_THREAD_ID_KEY] = server.threadId;
    return sealed;
  }

  // `defineProperty` can produce a descriptor assignment never would (non-enumerable, non-writable),
  // and that would be visible to JSON.stringify, spread, structuredClone and Object.keys — all of which
  // this context passes through. On a CLEAN prototype the two must be byte-identical.
  it.each([
    ['a full server identity', { a: 1, keep: 'me' }, { orgId: 'acme', resourceId: 'u1', threadId: 't1' }],
    ['an org only', { a: 1 }, { orgId: 'acme' }],
    ['no server values, spoofed body', { a: 1, org: 'victim', [GNL_RESOURCE_ID_KEY]: 'evil' }, {}],
  ])('%s', (_label, ctx, server) => {
    scrub();
    const viaDefine = sealRequestContext(structuredClone(ctx) as never, server as never);
    const viaAssign = sealByAssignment(structuredClone(ctx) as never, server as never);

    expect(Object.keys(viaDefine), 'property order changed').toEqual(Object.keys(viaAssign));
    expect(Object.getOwnPropertyDescriptors(viaDefine), 'the descriptors differ from what assignment produced')
      .toEqual(Object.getOwnPropertyDescriptors(viaAssign));
    expect(JSON.stringify(viaDefine)).toBe(JSON.stringify(viaAssign));
    expect({ ...viaDefine }).toEqual({ ...viaAssign });
    expect(structuredClone(viaDefine)).toEqual(structuredClone(viaAssign));
  });
});

describe('the run that receives a sealed context', () => {
  // Ties the change to the system: what a user-written dynamic function is handed, and what the
  // journal keeps. `persistInput` stores the RESOLVED system string, not the context — so the strip
  // cannot move replay determinism or journal bytes for any context that did not carry the key.
  it('hands a merge-safe context to a dynamic agent and journals none of the payload', async () => {
    scrub();
    const journal = new InMemoryJournal();
    let seen: Record<string, unknown> | undefined;
    const gnl = createGnl({
      journal,
      agents: {
        a: {
          model: createMockModel(async () => finalTextResult('ok')),
          system: (ctx) => { seen = ctx as Record<string, unknown>; return `sys for ${ctx.org ?? 'none'}`; },
        },
      },
    });

    const body = JSON.parse('{"a":1,"__proto__":{"isAdmin":true}}');
    await gnl.run('a', { runId: 'r1', prompt: 'hi', context: sealRequestContext(body, { orgId: 'acme' }) });

    expect(seen, 'the dynamic system function never ran').toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(seen!, '__proto__'), 'user code was handed the live payload').toBe(false);
    expect((Object.assign({}, seen!) as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(seen!.org).toBe('acme');

    const dump = (await Promise.all((await journal.listKeys('')).map((k) => journal.get(k))))
      .map((v) => JSON.stringify(v ?? null)).join('|');
    expect(dump, 'the payload reached the journal').not.toContain('isAdmin');
    expect(dump, 'the request context is journaled verbatim, so the strip changes replay bytes').not.toContain('__proto__');
    expect(dump, 'the resolved system did not freeze into the input').toContain('sys for acme');
  });
});

/**
 * KNOWN RESIDUAL — the strip is SHALLOW, and nothing downstream removes a nested payload.
 *
 * `sealRequestContext` drops `__proto__` from the context OBJECT. A `__proto__` one level down, inside
 * a context VALUE, is untouched, and the same one-line merge re-arms it:
 *
 *   context {"profile": {"__proto__": {"isAdmin": true}, "name": "x"}}
 *   Object.assign({}, sealed.profile).isAdmin  ->  true
 *
 * Measured: neither `structuredClone` nor a JSON round-trip removes it, so there is no cheap deep fix —
 * closing it means recursively rewriting arbitrary caller data on every request.
 *
 * These tests assert the CURRENT boundary so it is written down and so a future deep strip fails them
 * loudly rather than passing unnoticed. They are not an endorsement: they are the line where the
 * seal's guarantee stops.
 */
describe('what the strip does NOT cover (documented boundary, not a guarantee)', () => {
  const nested = () => sealRequestContext(JSON.parse('{"a":1,"profile":{"__proto__":{"isAdmin":true},"name":"x"}}'), {});

  it('a `__proto__` nested inside a context value survives the seal', () => {
    scrub();
    const sealed = nested();
    expect(Object.prototype.hasOwnProperty.call(sealed.profile as object, '__proto__')).toBe(true);
  });

  it('and merging that nested value still hijacks a prototype', () => {
    scrub();
    const merged = Object.assign({}, nested().profile as object) as Record<string, unknown>;
    expect(merged.isAdmin, 'if this is now undefined the strip went deep — update this block').toBe(true);
  });

  it('no serialization step the context passes through removes it', () => {
    scrub();
    const sealed = nested();
    for (const copy of [structuredClone(sealed), JSON.parse(JSON.stringify(sealed))]) {
      expect(Object.prototype.hasOwnProperty.call(copy.profile as object, '__proto__')).toBe(true);
    }
  });
});

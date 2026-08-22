// A conversation store handed over as an object has no organization boundary, and this host served it.
//
// `orgInstance` builds a per-organization registry with `{ ...config, journal: scoped }`. The spread
// carried `config.memory` through untouched, and `createGnl` resolves memory as
// `config.memory ?? memoryFactory(...)` — so the object won and the factory was never called for an
// organization. Every organization shared ONE `Memory`, whose threads, messages, working memory and
// observations are keyed by a caller-chosen `threadId` alone. Naming another tenant's thread was
// enough to read it.
//
// Studio refuses this shape and warns at boot. This host had no equivalent guard, which is why the
// refusal below is at construction: a leak that only appears once two tenants exist is one nobody
// finds in development.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import type { Memory } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

/** A host memory object: one store, no notion of an organization — the shape every host reaches for. */
function hostMemory(): Memory {
  const threads = new Map<string, unknown[]>();
  return {
    getMessages: async (id: string) => threads.get(id) ?? [],
    append: async (id: string, msgs: unknown[]) => { threads.set(id, [...(threads.get(id) ?? []), ...msgs]); },
  } as unknown as Memory;
}

const base = () => ({ storage: new InMemoryStorage(), agents: {} });

describe('a conversation store that cannot be scoped', () => {
  it('is refused at construction when organizations are configured', () => {
    expect(() => createRestApi({ ...base(), memory: hostMemory() } as never, { org: {} } as never))
      .toThrow(/memoryFactory/);
  });

  it('names the fix, because the fix is a one-line config change', () => {
    let message = '';
    try { createRestApi({ ...base(), memory: hostMemory() } as never, { org: {} } as never); }
    catch (e) { message = (e as Error).message; }

    expect(message, 'the refusal does not say what to do instead').toMatch(/memoryFactory/);
    expect(message, 'the refusal does not say why').toMatch(/organization/i);
  });

  it('is allowed without organizations — a single tenant has nothing to isolate from', () => {
    expect(() => createRestApi({ ...base(), memory: hostMemory() } as never)).not.toThrow();
  });

  it('accepts `memory: false`, which is the host saying there is no store at all', () => {
    expect(() => createRestApi({ ...base(), memory: false } as never, { org: {} } as never)).not.toThrow();
  });
});

describe('memoryFactory under organizations', () => {
  it('is called once per organization, with that organization\'s journal', async () => {
    // The half that proves the drop worked: the factory has to actually run, and it has to receive a
    // scoped journal — not the root one every organization would otherwise share.
    const seen: unknown[] = [];
    const api = createRestApi({
      ...base(),
      memoryFactory: (j: unknown) => { seen.push(j); return hostMemory(); },
    } as never, { org: { resolve: (req: Request) => req.headers.get('x-gnl-org') ?? undefined } } as never);

    const hit = (org: string) => (api as unknown as (r: Request) => Promise<Response>)(
      new Request('http://x/runs', { headers: { 'x-gnl-org': org } }));
    // One call already happened at construction, for the root instance — that one is legitimate and
    // has its own store. Counting from here rather than from zero.
    const atBoot = seen.length;
    expect(atBoot, 'the root instance did not build a store').toBe(1);

    await hit('acme');
    await hit('globex');
    await hit('acme'); // cached instance — must not build a second store for the same organization

    expect(seen.length - atBoot, 'the factory was not called once per organization').toBe(2);
    expect(new Set(seen).size, 'two instances were handed the same journal').toBe(3);
  });
});

// `scopeConfigToOrg` is the one place a config becomes one organization's (chat, AG-UI, REST, scheduler
// runners). It scoped `storage` and `journal` but passed an explicit `memory` OBJECT through untouched:
// every organization built from that config shared one conversation store, keyed by a caller-chosen
// thread id alone. Measured by the conformance registry: another organization's user read the secret in
// the same thread. @gnldev/server refused this shape at boot; the standalone doors did not, because the
// rule lived in the server and not in the function they all call.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { BasicMemory } from '../src/memory.js';
import { createGnl } from '../src/registry.js';
import { scopeConfigToOrg } from '../src/org-storage.js';
import { user } from '../src/run-identity.js';
import { createMockModel, finalTextResult } from './mock.js';

const SECRET = 'SECRET-OF-ACME';
/** Answers with every user message it was shown, so history handed to the wrong caller surfaces. */
const echo = () => createMockModel(async ({ prompt }: any) => finalTextResult(`echo:${(prompt ?? []).filter((m: any) => m.role === 'user').map((m: any) => (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : String(m.content))).join('|')}`));

/** Acme's user writes the secret on thread T, then globex's user speaks on thread T. What does globex see? */
async function crossOrg(config: any): Promise<string> {
  try {
    const acme = createGnl(scopeConfigToOrg(config, 'acme').config);
    const globex = createGnl(scopeConfigToOrg(config, 'globex').config);
    await acme.run('a', { runId: 'r1', prompt: SECRET, threadId: 'T', caller: user('ayse', 'acme') });
    return (await globex.run('a', { runId: 'r2', prompt: 'x', threadId: 'T', caller: user('eve', 'globex') })).text;
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
}

describe('an explicit memory object cannot cross organizations', () => {
  it('another organization\'s user does not read the thread (the claim)', async () => {
    const storage = new InMemoryStorage();
    const got = await crossOrg({ storage, memory: new BasicMemory(storage.runs), agents: { a: { model: echo() } } });
    expect(got).not.toContain(SECRET);
  });

  it('it is refused at scoping, and the refusal names the remedy', () => {
    const storage = new InMemoryStorage();
    expect(() => scopeConfigToOrg({ storage, memory: new BasicMemory(storage.runs) } as never, 'acme')).toThrow(/memoryFactory/);
  });

  it('journal-only config: the same refusal', async () => {
    const storage = new InMemoryStorage();
    expect(() => scopeConfigToOrg({ journal: storage.runs, memory: new BasicMemory(storage.runs) } as never, 'acme')).toThrow(/memoryFactory/);
  });
});

describe('siblings: the scoped forms keep working', () => {
  it('memoryFactory: each organization has its own threads, and the owner still sees her history', async () => {
    const storage = new InMemoryStorage();
    const config: any = { storage, memoryFactory: (src: any) => new BasicMemory(src.runs ?? src), agents: { a: { model: echo() } } };
    expect(await crossOrg(config)).not.toContain(SECRET);
    const acme = createGnl(scopeConfigToOrg(config, 'acme').config);
    const again = await acme.run('a', { runId: 'r3', prompt: 'more', threadId: 'T', caller: user('ayse', 'acme') });
    expect(again.text).toContain(SECRET); // control: the history is there for its owner
  });

  it('memory: false is "no conversation store" and needs no boundary', () => {
    const storage = new InMemoryStorage();
    expect(() => scopeConfigToOrg({ storage, memory: false } as never, 'acme')).not.toThrow();
  });
});

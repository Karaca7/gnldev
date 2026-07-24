// Agent approval registry — the governance gate for code-defined agents (drift re-approval is the point).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import {
  fingerprintAgent, recordAgent, approveAgent, blockAgent, agentApprovalStatus,
  isAgentServable, listAgentRegistry,
} from '../src/agent-registry.js';
import type { AgentConfig } from '../src/registry.js';

const mkCfg = (over: Partial<AgentConfig> = {}): AgentConfig => ({ model: 'openai/gpt-4o-mini', ...over });

describe('agent-registry — approval gate', () => {
  it('first sight → pending → approve → servable', async () => {
    const j = new InMemoryJournal();
    const cfg = mkCfg();
    const fp = fingerprintAgent('support', cfg);
    const rec = await recordAgent(j, 'support', fp);
    expect(rec.status).toBe('pending');
    expect(await isAgentServable(j, 'support')).toBe(false); // pending → NOT servable

    await approveAgent(j, 'support', 'admin@acme');
    expect(await isAgentServable(j, 'support')).toBe(true); // approved → servable
    const after = await agentApprovalStatus(j, 'support');
    expect(after).toMatchObject({ status: 'approved', approvedBy: 'admin@acme', approvedFingerprint: fp });
  });

  it('DRIFT: an approved agent whose config changes flips to `changed` and stops being servable until re-approved', async () => {
    const j = new InMemoryJournal();
    const cfg1 = mkCfg({ tools: { search: {} as any } });
    await recordAgent(j, 'a', fingerprintAgent('a', cfg1));
    await approveAgent(j, 'a', 'admin');
    expect(await isAgentServable(j, 'a')).toBe(true);

    // Config drifts: a NEW tool is added → next boot records the new fingerprint.
    const cfg2 = mkCfg({ tools: { search: {} as any, refund: {} as any } });
    const rec = await recordAgent(j, 'a', fingerprintAgent('a', cfg2));
    expect(rec.status).toBe('changed'); // drift detected
    expect(await isAgentServable(j, 'a')).toBe(false); // NOT servable — behavior can't silently change

    // Re-approve the new shape → servable again, pinned to the new fingerprint.
    await approveAgent(j, 'a', 'admin');
    expect(await isAgentServable(j, 'a')).toBe(true);
    // A re-boot with the SAME (now-approved) config stays approved (no false drift).
    const stable = await recordAgent(j, 'a', fingerprintAgent('a', cfg2));
    expect(stable.status).toBe('approved');
  });

  it('an IDENTICAL config re-boot does not disturb an approved agent (no false drift)', async () => {
    const j = new InMemoryJournal();
    const cfg = mkCfg({ system: 'You are helpful.' });
    const fp = fingerprintAgent('b', cfg);
    await recordAgent(j, 'b', fp);
    await approveAgent(j, 'b', 'admin');
    for (let i = 0; i < 3; i++) {
      const rec = await recordAgent(j, 'b', fingerprintAgent('b', cfg)); // same config, repeated boots
      expect(rec.status).toBe('approved');
    }
    expect(await isAgentServable(j, 'b')).toBe(true);
  });

  it('block → not servable regardless of fingerprint; a plain re-record keeps it blocked', async () => {
    const j = new InMemoryJournal();
    await recordAgent(j, 'c', fingerprintAgent('c', mkCfg()));
    await blockAgent(j, 'c', 'admin', 'policy violation');
    expect(await isAgentServable(j, 'c')).toBe(false);
    const rec = await recordAgent(j, 'c', fingerprintAgent('c', mkCfg({ maxSteps: 8 }))); // even a change
    expect(rec.status).toBe('blocked'); // stays blocked
    expect(rec.note).toBe('policy violation');
  });

  it('fingerprint is stable for the same config and changes on a real difference', async () => {
    expect(fingerprintAgent('x', mkCfg())).toBe(fingerprintAgent('x', mkCfg())); // deterministic
    expect(fingerprintAgent('x', mkCfg({ model: 'openai/gpt-4o' }))).not.toBe(fingerprintAgent('x', mkCfg())); // model change
    expect(fingerprintAgent('x', mkCfg({ system: 'a' }))).not.toBe(fingerprintAgent('x', mkCfg({ system: 'b' }))); // system change
    // dynamic (function) fields hash to a stable 'dyn' marker, not a crash
    expect(fingerprintAgent('x', mkCfg({ model: () => 'openai/gpt-4o' }))).toBe(fingerprintAgent('x', mkCfg({ model: () => 'anything' })));
  });

  it('listAgentRegistry enumerates records (newest first); throws without listKeys', async () => {
    const j = new InMemoryJournal();
    await recordAgent(j, 'a1', fingerprintAgent('a1', mkCfg()));
    await recordAgent(j, 'a2', fingerprintAgent('a2', mkCfg()));
    const list = await listAgentRegistry(j);
    expect(list.map((r) => r.name).sort()).toEqual(['a1', 'a2']);

    const noList = { get: async () => undefined, put: async () => {} } as any;
    await expect(listAgentRegistry(noList)).rejects.toThrow(/listKeys/);
  });
});

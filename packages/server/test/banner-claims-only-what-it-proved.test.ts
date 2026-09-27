// The startup banner may not claim a protection it cannot prove.
//
// `protections-view.ts` opens with the lesson: a banner maintained next to the config rather than
// derived from it is how `gnl dev` came to print "(auth: protected)" for a project whose only
// credential was one this framework had published. `createRestApi` derives its rows from
// `describeProtections` — except the identity row, which it fills in itself, and there it printed:
//
//   ✓ identity   bound via the authenticated principal   explicit
//
// for every deployment that passed ANY provider. Measured, on exactly the shape `gnl add host` and
// `gnl add auth` generate (`roleAuth({ admin: { token } })` — see cli/src/hosts.ts, recipes.ts):
// `roleAuth` fills `principal.id` only from `cred.user` (auth/role-auth.ts), so a bearer token carries
// no name, `resolveResourceId` never reaches the principal, runs are born ownerless, and a `viewer`
// read every subject's runs. The banner said bound; nothing was.
//
// Whether a principal carries a name is a fact about the CREDENTIAL, and this host sees a provider,
// not its credentials — so the honest answer at construction is `unknown`, which the row vocabulary
// already has. `gnl doctor` and `gnl dev` see the config's credentials and can say more; this surface
// cannot, and saying less is the point.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const mkModel = () => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
  }),
});

/** Constructs the host and returns the identity line of the banner it printed. */
function identityLine(opts: Record<string, unknown>): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  try {
    createRestApi(
      { storage: new InMemoryStorage(), memory: false, agents: { a: { model: mkModel() as never } } } as never,
      opts as never,
    );
  } finally { spy.mockRestore(); }
  return lines.join('\n').split('\n').find((l) => l.includes('identity')) ?? '';
}

describe('the protections banner claims only what it proved', () => {
  it('a bearer-token provider — what the scaffold generates — is not claimed as bound', () => {
    const line = identityLine({ auth: roleAuth({ admin: { token: 'A' } }) });
    expect(line, 'the banner must still have an identity row').toContain('identity');
    expect(line, 'a provider alone does not bind a subject: a bearer credential carries no name')
      .not.toContain('bound via');
    // The GLYPH, not only the sentence. A mutation that kept honest wording and printed `✓` passed the
    // assertion above — and `✓` is what a reader scans down the column, so it is the claim.
    expect(line.trimStart().startsWith('\u2713'),
      `the row is marked as an active protection: ${line.trim()}`).toBe(false);
  });

  it('no provider at all is still stated as NOT bound — that one IS provable', () => {
    // The control: honesty must not collapse into "unknown" everywhere. With no provider there is no
    // principal, so the subject can only come from the body, and that is a fact this host can prove.
    const line = identityLine({ allowOpenAccess: true });
    expect(line).toContain('not bound');
  });
});

// The two implementations of the exposure rule, held to one answer.
//
// `@gnldev/auth`'s exposure.ts owns the rule; `../src/bind.ts` carries a second implementation because
// this package ships with no hard runtime dependencies and is built with plain tsc (both files' headers
// say why at length). Duplicated security logic is only safe while something proves the copies agree,
// and these two had already drifted four ways — each copy leaving open a hole the other had closed.
//
// So this is the guard: ONE table, run through BOTH. Every row asserts the same answer from each side,
// which means a change to either implementation that is not made to the other fails here rather than in
// somebody's deployment. The four historical divergences are the first four rows, by name.
import { describe, it, expect } from 'vitest';
import { decideExposure } from '@gnldev/auth';
import { resolveBind } from '../src/bind.js';

type Row = {
  what: string;
  host?: string;
  authed: boolean;
  tokens?: (string | undefined)[];
  allowOpenNetwork?: boolean;
};

/** The behaviour contract. Both implementations must answer every row identically. */
const CASES: Row[] = [
  // ── the four measured divergences, pinned by name ──
  { what: 'LOCALHOST — case must not decide whether a host is local', host: 'LOCALHOST', authed: false },
  { what: '127.5.5.5 — the whole of 127/8 is loopback, not just .0.1', host: '127.5.5.5', authed: false },
  { what: '127.0.0.1.evil.com — a prefix match is not an address', host: '127.0.0.1.evil.com', authed: false, allowOpenNetwork: true },
  { what: 'admin-dev on the network — a published token is not auth', host: '0.0.0.0', authed: true, tokens: ['admin-dev', undefined] },

  // ── the ordinary grid ──
  { what: 'default host, no auth', authed: false },
  { what: 'default host, auth', authed: true, tokens: ['s3cret', undefined] },
  { what: 'explicit 127.0.0.1, no auth', host: '127.0.0.1', authed: false },
  { what: 'localhost lowercase normalises to an address', host: 'localhost', authed: false },
  { what: 'IPv6 loopback', host: '::1', authed: false },
  { what: 'bracketed IPv6 loopback', host: '[::1]', authed: false },
  { what: 'network host with real auth', host: '10.0.0.5', authed: true, tokens: ['s3cret', undefined] },
  { what: 'network host, no auth, no flag — refused', host: '10.0.0.5', authed: false },
  { what: 'network host, no auth, flag given', host: '10.0.0.5', authed: false, allowOpenNetwork: true },
  { what: 'wildcard IPv4 is never printed as dialable', host: '0.0.0.0', authed: false, allowOpenNetwork: true },
  { what: 'wildcard IPv6 is never printed as dialable', host: '::', authed: false, allowOpenNetwork: true },
  { what: 'viewer-dev alone is also a published token', host: '0.0.0.0', authed: true, tokens: [undefined, 'viewer-dev'] },
  { what: 'one published + one real token is auth', host: '0.0.0.0', authed: true, tokens: ['admin-dev', 'real-one'] },
  { what: 'no tokens at all is the auth-off case, not the published case', host: '0.0.0.0', authed: false, tokens: [undefined, undefined] },
  { what: 'an out-of-range octet is not an address', host: '127.0.0.999', authed: false, allowOpenNetwork: true },
  { what: 'whitespace around a loopback host', host: '  127.0.0.1  ', authed: false },
];

/** What both sides must agree on: the decision, not the wording of the message. */
type Normalized = {
  refused: boolean;
  loopback: boolean;
  exposed: boolean;
  hostname: string;
  displayHost: string;
  authed: boolean;
  shippedCredential: boolean;
  authModeLabel: string;
};

function viaAuth(row: Row): Normalized {
  const d = decideExposure({
    host: row.host,
    authed: row.authed,
    credentialTokens: row.tokens,
    allowOpenNetwork: !!row.allowOpenNetwork,
    surface: 'gnl dev',
    authRemedy: 'Configure auth.',
  });
  return {
    refused: Boolean(d.refusal),
    loopback: d.loopback,
    exposed: d.exposed,
    hostname: d.hostname,
    displayHost: d.displayHost,
    authed: d.authed,
    shippedCredential: d.shippedCredential,
    authModeLabel: d.authModeLabel,
  };
}

function viaCli(row: Row): Normalized {
  try {
    const b = resolveBind({
      host: row.host,
      authed: row.authed,
      credentialTokens: row.tokens,
      allowOpenNetwork: !!row.allowOpenNetwork,
      command: 'gnl dev',
    });
    return {
      refused: false,
      loopback: !b.exposed,
      exposed: b.exposed,
      hostname: b.hostname,
      displayHost: b.displayHost,
      authed: b.authed,
      shippedCredential: b.shippedCredential,
      authModeLabel: b.authModeLabel,
    };
  } catch {
    // The CLI throws where the shared decision returns a refusal string; a refusal carries no other
    // answer, so `refused` is the whole comparison for these rows.
    return {
      refused: true,
      loopback: false,
      exposed: true,
      hostname: '',
      displayHost: '',
      authed: false,
      shippedCredential: false,
      authModeLabel: '',
    };
  }
}

describe('the exposure rule has two implementations and one answer', () => {
  for (const row of CASES) {
    it(row.what, () => {
      const a = viaAuth(row);
      const c = viaCli(row);
      if (a.refused || c.refused) {
        // A refusal is the answer; the fields behind it are not computed on either side.
        expect(c.refused, `refusal disagrees for host '${row.host ?? '(default)'}'`).toBe(a.refused);
        return;
      }
      expect(c).toEqual(a);
    });
  }

  it('every row is actually exercised on both sides — no silently skipped table', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    // A table that refuses everything would pass the loop above while proving nothing.
    const refusals = CASES.filter((r) => viaAuth(r).refused).length;
    expect(refusals).toBeGreaterThan(0);
    expect(refusals).toBeLessThan(CASES.length);
  });

  it('the two published-token lists are the same list', () => {
    // Asserted through behaviour rather than by exporting the set from both sides: a token in one list
    // and not the other is exactly the drift this file exists to catch.
    for (const t of ['admin-dev', 'viewer-dev']) {
      const row: Row = { what: t, host: '0.0.0.0', authed: true, tokens: [t, undefined] };
      expect(viaCli(row).refused, `${t} treated as real auth by the CLI copy`).toBe(true);
      expect(viaAuth(row).refused, `${t} treated as real auth by the shared rule`).toBe(true);
    }
  });
});

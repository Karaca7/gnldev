// Where a dev server listens, and who is allowed to reach it.
//
// `serve({ fetch, port })` does not pass a hostname, and @hono/node-server then binds `::` — every
// interface, IPv4 included. Both `gnl dev` and `gnl studio` did this while printing
// `http://localhost:<port>`, so the line an operator read said "local" and the socket said "the whole
// network". On a laptop joined to an office or café network that published the admin surface —
// purgeRun, managed-agent create/promote, cache invalidation, and a Playground that executes models
// with the operator's own API keys — to anyone who could reach the port. `gnl studio` never wired an
// auth provider at all, so there was nothing in front of it either.
//
// The default is now loopback, which is what the printed URL always claimed. Reaching the process from
// elsewhere is a deliberate act (`--host`), and doing that with no auth requires saying so
// (`--allow-open-network`) — the flag exists so the answer is recorded in the command line rather than
// assumed.
//
// KNOWN BREAK, stated rather than buried: a containerised `gnl dev` must now pass `--host 0.0.0.0`, or
// it will not be reachable from the host. That is the point — the previous default was reachable from
// considerably more than the host.
//
// ── THIS IS A SECOND IMPLEMENTATION, AND IT IS PINNED ──────────────────────────────────────────────
// The rule itself belongs to `@gnldev/auth`'s exposure.ts, which `packages/studio` imports directly.
// This package cannot: it ships with no hard runtime dependencies on purpose (see runtime.ts — `npx
// @gnldev/cli init` must not pull the runtime in, and commands run against the PROJECT's installed
// versions), and it is built with plain `tsc`, so a value import would emit a real `require`.
// Resolving the rule from the project instead would make a security decision ABSENT whenever the
// package is not installed — worse than duplication.
//
// So the behaviour has one owner and the code has two, and the duplication is held shut by
// `test/exposure-parity.test.ts`: one table of hosts and credentials, run through BOTH
// implementations, failing on any divergence. That table is there because these two copies HAD
// drifted — four ways, each copy leaving open a hole the other had closed (see exposure.ts's header).
// If this package ever gains a bundler or a hard dependency on @gnldev/auth, delete this copy.

/** Credentials that were once written literally into a scaffolded project by this package, and so were
 *  published in its npm tarball. A project still carrying one is not authenticated in any sense that
 *  matters — anybody can read the value out of the registry — so it must not satisfy the network
 *  refusal below. New scaffolds generate a random token per project (see recipes.ts), which is why
 *  this is a fixed, closed list rather than a heuristic: it can only ever shrink.
 *  MIRROR OF @gnldev/auth's PUBLISHED_DEV_TOKENS. */
const PUBLISHED_DEV_TOKENS = new Set(['admin-dev', 'viewer-dev']);

/** Does this credential set consist only of values this package once published? */
export function isPublishedDevCredential(tokens: Iterable<string | undefined>): boolean {
  const present = [...tokens].filter((t): t is string => typeof t === 'string' && t.length > 0);
  return present.length > 0 && present.every((t) => PUBLISHED_DEV_TOKENS.has(t));
}

/**
 * Addresses that are only reachable from this machine.
 *
 * The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1 — which is why this parses octets instead
 * of matching against a fixed list or a prefix. The fixed list refused `gnl dev --host 127.5.5.5`,
 * which is a local address; the prefix version (`startsWith('127.')`, which studio's copy used)
 * accepts `127.0.0.1.evil.com` — a hostname that resolves wherever its owner points it, treated as
 * local. MIRROR OF @gnldev/auth's isLoopbackHost.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

export interface BindChoice {
  /** Passed to serve() as `hostname` — never left undefined, so the bind is never implicit. */
  hostname: string;
  /** What to print, reflecting the address actually bound. */
  displayHost: string;
  exposed: boolean;
  /** Auth AFTER the published-credential rule. This, not the caller's input, is what decided. */
  authed: boolean;
  shippedCredential: boolean;
  /** What to print for "auth: …" — the honest reading, not the presence of a provider. */
  authModeLabel: 'open' | 'shipped dev token — treat as OPEN' | 'protected';
}

/**
 * Decide the bind address, refusing the one combination that is unsafe by construction: reachable from
 * the network AND unauthenticated. `authed` is whether an auth provider actually resolved — not whether
 * one was configured, because a misconfigured provider that resolves to undefined is the case most
 * likely to be believed and least likely to be checked.
 *
 * `credentialTokens` is taken rather than a pre-computed flag so that forgetting the
 * published-credential rule is not possible at a call site. It was forgotten at one: the boot notice
 * was passed the RAW provider check, so a project carrying only `admin-dev` printed
 * "(auth: protected)" one line under a mode banner that correctly said "treat as OPEN".
 */
export function resolveBind(opts: {
  host?: string;
  authed: boolean;
  credentialTokens?: Iterable<string | undefined>;
  allowOpenNetwork: boolean;
  command: string;
}): BindChoice {
  const host = (opts.host ?? '127.0.0.1').trim();
  const shippedCredential = opts.credentialTokens ? isPublishedDevCredential(opts.credentialTokens) : false;
  const authed = opts.authed && !shippedCredential;
  const authModeLabel = !opts.authed ? 'open' : shippedCredential ? 'shipped dev token — treat as OPEN' : 'protected';
  const common = { authed, shippedCredential, authModeLabel } as const;

  if (isLoopbackHost(host)) {
    return { hostname: host.toLowerCase() === 'localhost' ? '127.0.0.1' : host, displayHost: 'localhost', exposed: false, ...common };
  }

  if (!authed && !opts.allowOpenNetwork) {
    throw new Error(
      `gnl: refusing to serve '${opts.command}' on ${host} without auth.\n` +
        (shippedCredential
          ? '  The only credential configured is one this package PUBLISHED in its own npm tarball —\n' +
            '  anybody can read the value out of the registry, so it protects nothing.\n'
          : '') +
        `  This binds an ADMIN surface — run purge, managed-agent promote, cache invalidation, and a\n` +
        `  Playground that spends your API keys — to every host that can reach the port.\n` +
        `  Configure auth (gnl.config \`auth: { admin: { token: ... } }\`, or GNL_ADMIN_TOKEN in the\n` +
        `  environment), or, if the network is genuinely trusted, pass --allow-open-network.`,
    );
  }
  // 0.0.0.0/:: are wildcards, not addresses you can visit — show something dialable instead.
  const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return { hostname: host, displayHost: display, exposed: true, ...common };
}

/** One line, at boot, saying exactly what is exposed to whom. Empty when nothing is.
 *  Reads the EFFECTIVE `authed` off the decision, so it cannot contradict the mode banner beside it. */
export function exposureNotice(bind: BindChoice): string {
  if (!bind.exposed) return '';
  return bind.authed
    ? `          reachable from the network on ${bind.hostname} (auth: protected)`
    : `          ⚠  reachable from the network on ${bind.hostname} with NO AUTH (--allow-open-network)`;
}

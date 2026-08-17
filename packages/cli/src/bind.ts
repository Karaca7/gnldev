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

/** Addresses that are only reachable from this machine. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

export interface BindChoice {
  /** Passed to serve() as `hostname` — never left undefined, so the bind is never implicit. */
  hostname: string;
  /** What to print, reflecting the address actually bound. */
  displayHost: string;
  exposed: boolean;
}

/**
 * Decide the bind address, refusing the one combination that is unsafe by construction: reachable from
 * the network AND unauthenticated. `authed` is whether an auth provider actually resolved — not whether
 * one was configured, because a misconfigured provider that resolves to undefined is the case most
 * likely to be believed and least likely to be checked.
 */
/**
 * Credentials that were once written literally into a scaffolded project by this package, and so were
 * published in its npm tarball. A project still carrying one is not authenticated in any sense that
 * matters — anybody can read the value out of the registry — so it must not satisfy the network
 * refusal below. New scaffolds generate a random token per project (see recipes.ts), which is why
 * this is a fixed, closed list rather than a heuristic: it can only ever shrink.
 */
const PUBLISHED_DEV_TOKENS = new Set(['admin-dev', 'viewer-dev']);

/** Does this credential set consist only of values this package once published? */
export function isPublishedDevCredential(tokens: Iterable<string | undefined>): boolean {
  const present = [...tokens].filter((t): t is string => typeof t === 'string' && t.length > 0);
  return present.length > 0 && present.every((t) => PUBLISHED_DEV_TOKENS.has(t));
}

export function resolveBind(opts: {
  host?: string;
  authed: boolean;
  allowOpenNetwork: boolean;
  command: string;
}): BindChoice {
  const host = (opts.host ?? '127.0.0.1').trim();
  if (isLoopbackHost(host)) return { hostname: host === 'localhost' ? '127.0.0.1' : host, displayHost: 'localhost', exposed: false };

  if (!opts.authed && !opts.allowOpenNetwork) {
    throw new Error(
      `gnl: refusing to serve '${opts.command}' on ${host} without auth.\n` +
        `  This binds an ADMIN surface — run purge, managed-agent promote, cache invalidation, and a\n` +
        `  Playground that spends your API keys — to every host that can reach the port.\n` +
        `  Configure auth (gnl.config \`auth: { admin: { token: ... } }\`, or GNL_ADMIN_TOKEN in the\n` +
        `  environment), or, if the network is genuinely trusted, pass --allow-open-network.`,
    );
  }
  // 0.0.0.0/:: are wildcards, not addresses you can visit — show something dialable instead.
  const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return { hostname: host, displayHost: display, exposed: true };
}

/** One line, at boot, saying exactly what is exposed to whom. Empty when nothing is. */
export function exposureNotice(bind: BindChoice, authed: boolean): string {
  if (!bind.exposed) return '';
  return authed
    ? `          reachable from the network on ${bind.hostname} (auth: protected)`
    : `          ⚠  reachable from the network on ${bind.hostname} with NO AUTH (--allow-open-network)`;
}

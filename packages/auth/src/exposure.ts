// Who is allowed to reach a GNL surface that listens on a socket — decided once, here.
//
// The decision existed TWICE before this file: `packages/studio/src/expose.ts` and
// `packages/cli/src/bind.ts`, each written for its own command, each the only caller of its own copy.
// They agreed on the sentence that matters ("reachable from the network AND unauthenticated is
// refused") and disagreed on four inputs. Both copies were run against the same hosts, and the
// divergences were not cosmetic — each copy left open a hole the other had already closed:
//
//   host / credential        studio's copy          cli's copy
//   LOCALHOST                not loopback           loopback
//   127.5.5.5                loopback               not loopback      (cli over-refuses: 127/8 IS loopback)
//   127.0.0.1.evil.com       LOOPBACK               not loopback      (studio serves an admin panel
//                                                                      unauthenticated on a name whose
//                                                                      DNS somebody else controls)
//   auth: { admin: 'admin-dev' }
//     on --host 0.0.0.0      serves, "protected"    refuses           (`admin-dev` was published in this
//                                                                      project's own npm tarball, so the
//                                                                      value is readable in the registry)
//
// Two hand-synchronised copies of a security rule had already drifted, so "keep them in sync" is not a
// plan — it is the thing that was tried. This module is the one that decides.
//
// WHY THE CODE STILL EXISTS TWICE, stated rather than buried: `@gnldev/cli` ships with no hard runtime
// dependencies on purpose (see cli/src/runtime.ts — `npx @gnldev/cli init` must not pull the runtime in,
// and commands must run against the PROJECT's installed versions), and it is built with plain `tsc`, so a
// value import of this package would emit a real `require`. Resolving this rule from the project instead
// would make a security decision absent whenever the package is not installed, which is worse than the
// drift. So `bind.ts` keeps its own implementation of the same rule, and
// `packages/cli/test/exposure-parity.test.ts` runs one table of hosts and credentials through BOTH and
// fails on any divergence. One owner of the BEHAVIOUR; two implementations of the code, mechanically
// pinned. If @gnldev/cli ever gains a bundler or a hard dependency on this package, delete the copy.

/** Credentials this project once wrote literally into scaffolded projects, and so published to npm.
 *  A project still carrying one is not authenticated in any sense that matters — anybody can read the
 *  value out of the registry. Fixed and closed rather than a heuristic: it can only ever shrink. */
export const PUBLISHED_DEV_TOKENS: ReadonlySet<string> = new Set(['admin-dev', 'viewer-dev']);

/** Does this credential set consist ONLY of values this project once published? */
export function isPublishedDevCredential(tokens: Iterable<string | undefined>): boolean {
  const present = [...tokens].filter((t): t is string => typeof t === 'string' && t.length > 0);
  return present.length > 0 && present.every((t) => PUBLISHED_DEV_TOKENS.has(t));
}

/**
 * Addresses reachable only from this machine.
 *
 * The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1 — which is why this parses octets instead
 * of matching a prefix. `startsWith('127.')` is the tempting version and it accepts
 * `127.0.0.1.evil.com`: a hostname that resolves wherever its owner points it, treated as local.
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

/** Wildcards are bind targets, not addresses anybody can visit. */
function isWildcardHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === '0.0.0.0' || h === '::';
}

export interface ExposureInput {
  /** The `--host` value as given, before normalisation. Absent means the loopback default. */
  host?: string;
  /**
   * Did an auth provider actually RESOLVE — not "was one configured". A misconfigured provider that
   * reduces to undefined is the case most likely to be believed and least likely to be checked.
   */
  authed: boolean;
  /**
   * The literal credential values the provider was built from, when the caller can see them. Passed
   * rather than pre-checked so neither caller can forget the published-token rule: studio's copy
   * forgot it, and answered "protected" for a token readable in the npm registry.
   */
  credentialTokens?: Iterable<string | undefined>;
  /** `--allow-open-network` was passed. Deliberate, and recorded in the command that ran. */
  allowOpenNetwork: boolean;
  /** How the surface names itself in its own messages, e.g. `gnl studio`, `gnl dev`. */
  surface: string;
  /** The surface-specific sentence telling the operator how to configure auth here. The structure of
   *  the refusal is shared; only the remedy differs, because the surfaces genuinely differ. */
  authRemedy: string;
}

export interface ExposureDecision {
  loopback: boolean;
  /** Reachable from somewhere other than this machine. */
  exposed: boolean;
  /** Pass to `serve()` as `hostname` — never undefined, so the bind is never implicit. */
  hostname: string;
  /** What to print, reflecting the address actually bound (a wildcard is shown as something dialable). */
  displayHost: string;
  /** Auth AFTER the published-credential rule. This, not the input, is what the decision used. */
  authed: boolean;
  shippedCredential: boolean;
  /** What to print for "auth: …" — the honest reading, not the presence of a provider. */
  authModeLabel: 'open' | 'shipped dev token — treat as OPEN' | 'protected';
  /** What to hand the app as `allowOpenAccess`. */
  allowOpenAccess: boolean;
  /** When set, refuse to start and print this. */
  refusal?: string;
  /** Warnings to print, in order. Empty when there is nothing worth saying. */
  warnings: string[];
  /** One line, at boot, saying exactly what is exposed to whom. Empty when nothing is. */
  notice: string;
}

export function decideExposure(input: ExposureInput): ExposureDecision {
  const raw = (input.host ?? '127.0.0.1').trim();
  const loopback = isLoopbackHost(raw);
  const shippedCredential = input.credentialTokens ? isPublishedDevCredential(input.credentialTokens) : false;
  // The subtraction is done HERE so that forgetting it is not possible at a call site.
  const authed = input.authed && !shippedCredential;
  const hostname = loopback && raw.toLowerCase() === 'localhost' ? '127.0.0.1' : raw;
  const displayHost = loopback ? 'localhost' : isWildcardHost(raw) ? 'localhost' : raw;
  const authModeLabel = !input.authed ? 'open' : shippedCredential ? 'shipped dev token — treat as OPEN' : 'protected';
  const warnings: string[] = [];

  // The one combination that is unsafe by construction: reachable from the network AND
  // unauthenticated. Refused, not warned about.
  if (!loopback && !authed && !input.allowOpenNetwork) {
    return {
      loopback,
      exposed: true,
      hostname,
      displayHost,
      authed,
      shippedCredential,
      authModeLabel,
      allowOpenAccess: false,
      warnings,
      notice: '',
      refusal:
        `${input.surface}: refusing to serve on ${raw} without auth.\n` +
        (shippedCredential
          ? '  The only credential configured is one this project PUBLISHED in its own npm tarball —\n' +
            '  anybody can read the value out of the registry, so it protects nothing.\n'
          : '') +
        '  This is an ADMIN surface: policy/budget writes, retention purge, cache invalidation, and a\n' +
        '  Playground that spends your API keys — exposed to every host that can reach the port.\n' +
        `  ${input.authRemedy}\n` +
        '  Or, if the network is genuinely trusted, pass --allow-open-network.',
    };
  }

  if (!authed && loopback) {
    warnings.push(
      `${input.surface}: loopback host (127.0.0.0/8, ::1, localhost) → surface open without auth. On a ` +
        'shared machine other local users can also reach it; configure auth, or restrict access.',
    );
  }
  if (!loopback) {
    warnings.push(
      authed
        ? `${input.surface}: reachable from the network on ${raw} (auth: protected)`
        : `${input.surface}: ⚠  reachable from the network on ${raw} with NO AUTH (--allow-open-network)`,
    );
  }

  return {
    loopback,
    exposed: !loopback,
    hostname,
    displayHost,
    authed,
    shippedCredential,
    authModeLabel,
    // Only assert open access where it has actually been accepted. Asserting it while auth IS
    // configured would be a contradiction the gate has no way to resolve.
    allowOpenAccess: !authed && (loopback || input.allowOpenNetwork),
    warnings,
    notice: loopback
      ? ''
      : authed
        ? `reachable from the network on ${hostname} (auth: protected)`
        : `⚠  reachable from the network on ${hostname} with NO AUTH (--allow-open-network)`,
  };
}

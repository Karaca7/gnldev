// Who can reach the Studio, decided in one place that can be tested.
//
// This lived inline at the top of cli.ts, which meant it ran on import and could not be asserted on.
// Two defects hid there. `auth` from gnl.config was never read, so a user who configured an admin
// token got an open panel AND a warning telling them to configure the token they had just
// configured. And `allowOpenAccess = loopback` meant a non-loopback host merely passed `false` into
// the gate, which throws only under NODE_ENV=production — so `gnl-studio --host 0.0.0.0` outside
// production served an unauthenticated ADMIN surface to every interface and printed nothing.
//
// Extracted rather than fixed in place: a security decision that cannot be unit-tested is a decision
// nobody can check.

export interface ExposureInput {
  /** The `--host` value as given, before normalisation. */
  host: string;
  /** Did an auth provider actually RESOLVE — not "was one configured". A misconfigured provider that
   *  reduces to undefined is the case most likely to be believed and least likely to be checked. */
  authed: boolean;
  /** `--allow-open-network` was passed. Deliberate, and recorded in the command that ran. */
  allowOpenNetwork: boolean;
}

export interface ExposureDecision {
  /** When set, refuse to start and print this. */
  refusal?: string;
  /** What to hand `createStudioApp` as `allowOpenAccess`. */
  allowOpenAccess: boolean;
  /** Warnings to print, in order. Empty when there is nothing worth saying. */
  warnings: string[];
  loopback: boolean;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '[::1]' || h.startsWith('127.');
}

export function decideExposure({ host, authed, allowOpenNetwork }: ExposureInput): ExposureDecision {
  const loopback = isLoopbackHost(host);
  const warnings: string[] = [];

  // The one combination that is unsafe by construction: reachable from the network AND
  // unauthenticated. Refused, not warned about.
  if (!loopback && !authed && !allowOpenNetwork) {
    return {
      loopback,
      allowOpenAccess: false,
      warnings,
      refusal:
        `gnl studio: refusing to serve on ${host} without auth.\n` +
        '  This is an ADMIN surface: policy/budget writes, retention purge, cache invalidation, and a\n' +
        '  Playground that spends your API keys — exposed to every host that can reach the port.\n' +
        '  Configure auth in gnl.config (`auth: { admin: { token: ... } }`) and pass --config, or, if\n' +
        '  the network is genuinely trusted, pass --allow-open-network.',
    };
  }

  if (!authed && loopback) {
    warnings.push(
      'gnl studio: loopback host (127.0.0.1/::1/localhost) → panel open without auth. On a shared ' +
      'machine, other local users can also reach it; add `auth: { admin: { token: ... } }` to ' +
      'gnl.config and pass --config, or restrict access.',
    );
  }
  if (!loopback) {
    warnings.push(
      authed
        ? `gnl studio: reachable from the network on ${host} (auth: protected)`
        : `gnl studio: ⚠  reachable from the network on ${host} with NO AUTH (--allow-open-network)`,
    );
  }

  // Only assert open access where it has actually been accepted. Asserting it while auth IS
  // configured would be a contradiction the gate has no way to resolve.
  return { loopback, allowOpenAccess: !authed && (loopback || allowOpenNetwork), warnings };
}

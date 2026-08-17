// Is this a state-changing request that a page on another site caused?
//
// The default posture of a new gnl project is auth-off on loopback, which is the right default for a
// local tool — but "open to this machine" and "open to every page this machine's browser visits" are
// different things, and the gate treated them as one. With no provider it returned true for every
// request, and nothing anywhere looked at where the request came from.
//
// Measured on the publish candidate: a cross-origin request to `POST /api/retention/sweep` purged a
// seeded run (RUNS before [r-1] → purged:["r-1"] → RUNS after []). `POST /agents/:name/run` passed
// the same gate and would bill the project's API key. It is reachable from a plain
// `<form enctype="text/plain">` navigation, so it needs no CORS preflight and no fetch() permission
// — the same shape as the webpack-dev-server and Vite dev-server advisories.
//
// SCOPE — deliberately only the providerless case. When a provider IS configured the defence is the
// bearer token, which a cross-site page cannot read; gnl uses no cookies, so token auth is not
// CSRF-reachable. Applying this with a provider present would break legitimate cross-origin API
// clients for no gain.

/** Methods that cannot change state, so cross-site is not a concern for them. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `true` when the request both changes state AND was initiated by a different site.
 *
 * Primary signal is Fetch Metadata (`Sec-Fetch-Site`), which every current browser sends and no
 * page can forge. `same-site` is accepted rather than rejected: the documented dev setup proxies
 * `/api` through Vite so it is same-ORIGIN anyway, and rejecting same-site would break anyone
 * serving the UI from a sibling port for no meaningful gain — a hostile page on your own machine's
 * other port is a different threat model from any page on the internet.
 *
 * When the header is absent, the request is not from a modern browser. A non-browser client is not
 * the CSRF threat — it has no ambient credentials to be ridden — so it falls through to the `Origin`
 * hostname, and to allow when there is no Origin either. Hostname, not origin: ports must differ
 * freely (localhost:5173 → localhost:4747) while example.com must not.
 */
export function isCrossSiteStateChange(req: Request): boolean {
  if (SAFE.has(req.method.toUpperCase())) return false;

  const site = req.headers.get('sec-fetch-site');
  if (site) return site.trim().toLowerCase() === 'cross-site';

  const origin = req.headers.get('origin');
  if (!origin) return false;
  // `null` is an OPAQUE origin — a sandboxed iframe, a `data:` document, a `file://` page, some
  // redirect chains. It is never the app itself, so allowing it was the wrong side of the fence: the
  // earlier reading here was that Fetch Metadata covers those contexts, which is true of a current
  // browser but not of a client that omits the header. An opaque origin is not same-origin by
  // definition, so it is treated as cross-site.
  if (origin === 'null') return true;
  try {
    return new URL(origin).hostname !== new URL(req.url).hostname;
  } catch {
    return true; // an Origin that will not parse is not one to trust
  }
}

// Named READ permissions — who may SEE what, as opposed to who may DO what.
//
// `*:read` was the only read grant in the catalogue, so one decision covered runs, conversation
// content, spend and the governance log alike: "let support read runs" and "let support read every end
// user's messages" could not be told apart. The write axis had eight named permissions; the read axis
// had one.
//
// TWO PROPERTIES, and the file is worthless without both:
//   • the split WORKS — a narrower grant actually refuses (the matrix below);
//   • the split CHANGED NOTHING for anyone who did not ask for it — `*:read` still covers every named
//     read, and the free tier never sees a permission at all (the gate reduces `X:read` to
//     `action: 'read'`, which is what these routes already passed).
//
// The source guard at the bottom is the part that survives contact with future routes: a read route
// added later without a name is silently back inside "all or nothing", and nothing else would notice.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi, PERMISSION_CATALOG, ROLE_PERMISSION_PRESETS } from '../src/server.js';
import { call } from './call.js';

/** Minimal RBAC: matches a granted permission against the one the gate asked for, `*` wildcards included. */
const matches = (granted: string, required: string): boolean => {
  if (granted === '*' || granted === required) return true;
  const [gRes, gAct] = granted.split(':');
  const [rRes, rAct] = required.split(':');
  return (gRes === '*' || gRes === rRes) && (gAct === '*' || gAct === rAct);
};

const PEOPLE: Record<string, string[]> = {
  everything: ['*:read'],
  support: ['runs:read', 'catalog:read'],
  finance: ['money:read'],
  nothing: [],
};

function rbacApi() {
  const auth = {
    authenticate: (req: Request) => {
      const t = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      return PEOPLE[t] ? { id: t, orgId: 'acme', roles: ['viewer'], permissions: PEOPLE[t] } : null;
    },
    authorize: (p: { permissions?: string[] } | null, _r: Request, ctx: { permission?: string; action: string; path?: string }) => {
      // MIRRORS @gnldev/auth-ee rbac.ts `requiredPermission`: the gate's exact permission when it names
      // one, otherwise a rough `<first path segment>:<action>`. Getting this wrong made the suite lie
      // about un-naming a route: with a hardcoded 'unknown:read' fallback every coarse gate denied
      // everyone, so the behavioural tests kept passing while the split was being undone. The real
      // fallback is LOOSER — `/threads` coarse derives `threads:read` all by itself — which is why the
      // narrow grants below must be checked against it, not against a stricter invention.
      const fromPath = ctx.path?.split('/').filter(Boolean)[0];
      const need = ctx.permission ?? `${fromPath ?? 'unknown'}:${ctx.action}`;
      return (p?.permissions ?? []).some((g) => matches(g, need))
        ? { allow: true }
        : { allow: false as const, status: 403 as const, reason: `need ${need}` };
    },
    capabilities: () => ({ sso: true, rbac: true, audit: true, multiOrganization: true, users: true, plan: 'pro' }),
  };
  const j = new InMemoryJournal();
  return createStudioApi({ reader: j, journal: j, auth: auth as never, org: {} });
}

const ROUTES = {
  runs: '/runs',
  conversations: '/threads',
  spend: '/pricing',
  audit: '/audit',
  users: '/users',
  configuration: '/agents',
} as const;

const status = (app: never, who: string, path: string) =>
  call(app, path, { headers: { authorization: `Bearer ${who}` } }).then((r) => r.status);

describe('named read permissions', () => {
  it('a support grant sees runs but NOT conversation content', async () => {
    // The ask this whole split exists for, and the one a customer raises first: an operator who needs
    // to see that a run failed does not need to read what the end user typed into it.
    const app = rbacApi() as never;
    expect(await status(app, 'support', ROUTES.runs)).toBe(200);
    expect(await status(app, 'support', ROUTES.conversations)).toBe(403);
  });

  it('each grant refuses everything outside it', async () => {
    const app = rbacApi() as never;
    const matrix: Record<string, Record<string, number>> = {};
    for (const who of ['everything', 'support', 'finance']) {
      matrix[who] = {};
      for (const [label, path] of Object.entries(ROUTES)) matrix[who]![label] = await status(app, who, path);
    }
    expect(matrix).toEqual({
      everything: { runs: 200, conversations: 200, spend: 200, audit: 200, users: 200, configuration: 200 },
      support: { runs: 200, conversations: 403, spend: 403, audit: 403, users: 403, configuration: 200 },
      finance: { runs: 403, conversations: 403, spend: 200, audit: 403, users: 403, configuration: 403 },
    });
  });

  it('a grant of nothing reads nothing — the permissions are what decide, not the role name', async () => {
    // All four personas carry roles: ['viewer']. If the role name were doing the work, this would pass
    // as a viewer and the matrix above would prove nothing.
    const app = rbacApi() as never;
    for (const path of Object.values(ROUTES)) expect(await status(app, 'nothing', path)).toBe(403);
  });

  it('`*:read` still grants every named read — no existing grant lost access', async () => {
    const named = PERMISSION_CATALOG.filter((p) => p.id.endsWith(':read') && p.id !== '*:read').map((p) => p.id);
    expect(named.length, 'the read axis is not split at all').toBeGreaterThan(1);
    for (const p of named) expect(matches('*:read', p), `'*:read' stopped covering '${p}'`).toBe(true);
  });

  it('the role presets are unchanged — a narrower set is a CHOICE, never a new default', async () => {
    // Picking a role must not silently take away access someone had yesterday.
    expect(ROLE_PERMISSION_PRESETS).toEqual({
      viewer: ['*:read'],
      member: ['*:read', 'agents:run'],
      admin: ['*'],
    });
  });

  it('the FREE tier is untouched: a plain viewer still reads everything', async () => {
    // The gate reduces any `X:read` to `action: 'read'`, so a free provider — which branches on the
    // action alone and never looks at `permission` — cannot tell that the routes were named.
    const j = new InMemoryJournal();
    const app = createStudioApi({
      reader: j, journal: j, org: {},
      auth: roleAuth({ admin: { token: 'A', orgId: 'acme' }, viewer: { token: 'V', orgId: 'acme' } }),
    }) as never;
    for (const path of Object.values(ROUTES)) expect(await status(app, 'V', path), `free viewer lost ${path}`).toBe(200);
  });
});

describe('no read route may go back to being unnamed', () => {
  /**
   * Routes that legitimately keep the coarse gate, and why each is not data.
   *
   * `/me` and `/permissions/catalog` are how a caller discovers WHO IT IS and WHAT IT MAY DO. Gating
   * them behind a read permission is circular: a user with no read grant could not learn that it has
   * no read grant, and the UI could not render the reason. `/auth/sse-ticket` mints a short-lived
   * ticket for the EventSource flow — an auth mechanism, not a resource; the stream it unlocks
   * (`/events`) is itself gated on `runs:read`.
   */
  const COARSE_ALLOWED = ['/me', '/permissions/catalog', '/auth/sse-ticket'];

  it('every read gate in the source names a permission, or is one of the three', () => {
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8').split('\n');
    const unnamed = src
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes("allow(c.req.raw, 'read')"))
      // The route a coarse gate belongs to is the nearest `app.<method>(...)` above it. NOT get-only:
      // `/auth/sse-ticket` is a POST that read-gates, and matching only GET reported it as "line 2410"
      // — an unattributed line number is a finding nobody can act on.
      .map(({ n }) => {
        for (let i = n - 1; i >= Math.max(0, n - 30); i--) {
          const m = src[i]?.match(/app\.(?:get|post|put|patch|delete)\('([^']*)'/);
          if (m) return m[1]!;
        }
        return `line ${n}`;
      })
      .filter((route) => !COARSE_ALLOWED.includes(route));

    expect(unnamed,
      'a read route is behind the coarse gate, so no permission can distinguish it — every grant that '
      + 'can read anything can read this. Name it (allowP) or add it to COARSE_ALLOWED with a reason.')
      .toEqual([]);
  });

  it('and every exemption still exists as a route', () => {
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    for (const route of COARSE_ALLOWED) {
      expect(new RegExp(`app\\.(?:get|post)\\('${route.replace(/\//g, '\\/')}'`).test(src),
        `a stale exemption outlived its route: ${route}`).toBe(true);
    }
  });
});

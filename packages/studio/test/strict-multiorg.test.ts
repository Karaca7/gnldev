// STRICT multi-org model (PAID: gated on the EE `multiOrganization` capability). The security matrix
// in BOTH modes:
//   • EE ON  → (1) org-bound sees only its org / 403 elsewhere; (2) EXPLICIT platform-admin sees & manages
//              all orgs; (3) org-less WITHOUT a platform grant is FAIL-CLOSED (403 — previously it was the
//              all-seeing operator); (4) an org-admin cannot write another org.
//   • EE OFF → legacy behavior EXACTLY: an org-less identity is the all-seeing operator (proved here + by
//              the existing auth-org suite).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth, type AuthProvider, type Principal } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

// A fake PAID provider: token → Principal, capabilities().multiOrganization = true (as real @gnldev/auth-ee
// with a valid `multiOrg` license). Write requires admin OR platform-admin; read is open to any principal.
function licensedAuth(map: Record<string, Principal>): AuthProvider {
  return {
    authenticate: (req) => {
      const h = req.headers.get('authorization');
      const tok = h?.startsWith('Bearer ') ? h.slice(7) : new URL(req.url).searchParams.get('token');
      return (tok && map[tok]) || null;
    },
    authorize: (p, _req, ctx) => {
      if (!p) return { allow: false, status: 401, reason: 'unauthenticated' };
      if (ctx.action === 'write') {
        return p.roles.includes('admin') || p.roles.includes('platform-admin')
          ? { allow: true }
          : { allow: false, status: 403, reason: 'admin required' };
      }
      return { allow: true };
    },
    capabilities: () => ({ multiOrganization: true }),
  };
}

const PRINCIPALS: Record<string, Principal> = {
  'a-adm': { id: 'a-adm', roles: ['admin'], orgId: 'acme' },       // org-bound admin (acme)
  'plat': { id: 'plat', roles: ['admin', 'platform-admin'] },      // EXPLICIT platform admin
  'lost': { id: 'lost', roles: ['admin'] },                        // org-less, NO grant → fail-closed
  'b-viw': { id: 'b-viw', roles: ['viewer'], orgId: 'globex' },    // org-bound viewer (globex)
};

async function seed(journal: InMemoryJournal) {
  await journal.put('org:acme:r-acme:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
  await journal.put('org:globex:r-globex:model:0', { content: [{ type: 'text', text: 'g' }], finishReason: 'stop' });
}

const H = (t: string) => ({ authorization: `Bearer ${t}` });
const JH = (t: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });

describe('@gnldev/studio strict multi-org (EE ON)', () => {
  it('(1) an org-bound identity reads ONLY its own org; a different org header → 403', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, auth: licensedAuth(PRINCIPALS), org: {} });

    const runs = await (await call(app, '/runs', { headers: H('a-adm') })).json();
    expect(runs.map((r: any) => r.runId)).toEqual(['r-acme']); // globex NOT visible

    expect((await call(app, '/runs', { headers: { ...H('a-adm'), 'x-gnl-org': 'globex' } })).status).toBe(403);
  });

  it('(2) an EXPLICIT platform-admin sees ALL orgs and can create one', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, auth: licensedAuth(PRINCIPALS), org: {} });

    const orgs = await (await call(app, '/organizations', { headers: H('plat') })).json();
    expect(orgs.organizations.map((o: any) => o.id).sort()).toEqual(['acme', 'globex']);

    // create a new org → 200
    expect((await call(app, '/organizations', { method: 'POST', headers: JH('plat'), body: JSON.stringify({ id: 'initech' }) })).status).toBe(200);
    // and it can also read root-scoped data (both orgs' prefixed runs)
    const runs = await (await call(app, '/runs', { headers: H('plat') })).json();
    expect(runs.length).toBe(2);
  });

  it('(3) FAIL-CLOSED: an org-less identity WITHOUT a platform grant is denied (was the all-seeing operator)', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, auth: licensedAuth(PRINCIPALS), org: {} });

    // org data read → 403 (previously it saw the whole root journal)
    expect((await call(app, '/runs', { headers: H('lost') })).status).toBe(403);
    // org management → 403
    expect((await call(app, '/organizations', { method: 'POST', headers: JH('lost'), body: JSON.stringify({ id: 'x' }) })).status).toBe(403);
    expect((await call(app, '/organizations', { headers: H('lost') })).status).toBe(403);
    // BUT /me still works (exempt) so the caller can learn its own (denied) scope
    const me = await (await call(app, '/me', { headers: H('lost') })).json();
    expect(me).toMatchObject({ platformAdmin: false, scope: 'none', strictMultiOrg: true });
  });

  it('(4) an org-admin cannot write another org (budget)', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const app = createStudioApi({ reader: journal, auth: licensedAuth(PRINCIPALS), org: {} });

    // its OWN org budget → 200 (a-adm is admin of acme)
    expect((await call(app, '/organizations/acme/budget', { method: 'PUT', headers: JH('a-adm'), body: JSON.stringify({ tokenLimit: 5 }) })).status).toBe(200);
    // another org → 403
    expect((await call(app, '/organizations/globex/budget', { method: 'PUT', headers: JH('a-adm'), body: JSON.stringify({ tokenLimit: 5 }) })).status).toBe(403);
    // and an org-bound identity can never create an org
    expect((await call(app, '/organizations', { method: 'POST', headers: JH('a-adm'), body: JSON.stringify({ id: 'z' }) })).status).toBe(403);
  });

  it('/me exposes the new scope + platformAdmin fields', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: licensedAuth(PRINCIPALS), org: {} });
    expect(await (await call(app, '/me', { headers: H('plat') })).json())
      .toMatchObject({ platformAdmin: true, scope: 'platform', operator: true, strictMultiOrg: true });
    expect(await (await call(app, '/me', { headers: H('a-adm') })).json())
      .toMatchObject({ platformAdmin: false, scope: 'org:acme', orgId: 'acme', operator: false });
  });
});

/**
 * The FREE tier, with organizations configured. This block used to assert the opposite — that an
 * org-less `admin` "still sees & manages everything" — because the fail-closed net was gated on the
 * paid `multiOrganization` capability alone.
 *
 * That made the unpaid deployment the less isolated one, which is the wrong direction for a security
 * default and is what `orgIsolationActive` (server + studio) now fixes. So the contract these two
 * tests state is the new one, and it is deliberately stronger than what it replaced: the old test
 * asserted only that the operator got through, and would still have passed if EVERY unbound identity
 * did. Both sides are pinned here — the undeclared admin is refused, the declared operator is not —
 * so neither collapsing the distinction nor deleting the grant can pass.
 */
describe('@gnldev/studio free tier + organizations: the platform scope must be DECLARED', () => {
  const freeApp = async (auth: ReturnType<typeof roleAuth>) => {
    const journal = new InMemoryJournal();
    await seed(journal);
    // free roleAuth: capabilities().multiOrganization === false → the PAID strict model is OFF
    return createStudioApi({ reader: journal, auth, org: {} });
  };

  it('an org-less plain admin is fail-CLOSED — a missing orgId never infers the platform scope', async () => {
    const app = await freeApp(roleAuth({ admin: { token: 'op' } }));
    expect((await call(app, '/runs', { headers: H('op') })).status).toBe(403);
    expect((await call(app, '/organizations', { method: 'POST', headers: JH('op'), body: JSON.stringify({ id: 'x' }) })).status).toBe(403);
  });

  it('the same identity declared as superAdmin sees & manages everything', async () => {
    const app = await freeApp(roleAuth({ superAdmin: { token: 'op' } }));
    // reads the whole root journal (both organizations' prefixed runs)
    expect((await (await call(app, '/runs', { headers: H('op') })).json()).length).toBe(2);
    // and can create an organization
    expect((await call(app, '/organizations', { method: 'POST', headers: JH('op'), body: JSON.stringify({ id: 'x' }) })).status).toBe(200);
  });
});

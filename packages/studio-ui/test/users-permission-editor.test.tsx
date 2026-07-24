// @vitest-environment jsdom
// Users view: rol + checkbox-seviyesi izin editörü (GET /permissions/catalog, POST/PATCH /users
// permissions[]). Covers: catalog enabled/disabled render gating, role→preset seeding, "untouched
// checkbox → pure role" vs "customized → explicit permissions[]" submit logic (create), and the
// edit dialog's pre-fill + PATCH body shape (including the explicit override-clear via permissions: []).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Users } from '../src/views/Users';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

// A route handler matches on (URL suffix, HTTP method) — unlike the simple endsWith-only helper used
// in views.test.tsx, this view needs GET and POST/PATCH to the SAME path ('/users') to answer differently.
function route(pathSuffix: string | RegExp, method: string, json: unknown) {
  return {
    match: (u: string, init?: RequestInit) => {
      const m = (init?.method ?? 'GET') === method;
      const p = typeof pathSuffix === 'string' ? u.endsWith(pathSuffix) : pathSuffix.test(u);
      return m && p;
    },
    json,
  };
}
function mockFetch(handlers: ReturnType<typeof route>[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const found = handlers.find((h) => h.match(String(url), init));
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => (found ? found.json : []),
    };
  }));
}
function postCall(pathSuffix: string, method = 'POST') {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls.find(([u, init]: any[]) => String(u).endsWith(pathSuffix) && init?.method === method);
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const CAPS = { userManage: true };
const ME = { id: null, roles: ['admin'], orgId: null, operator: true };
const CATALOG = {
  enabled: true,
  permissions: [
    { id: 'agents:run', label: 'Run agents', group: 'run' },
    { id: '*:read', label: 'View runs & data', group: 'read' },
    { id: 'users:write', label: 'Manage users', group: 'admin' },
  ],
  rolePresets: {
    viewer: ['*:read'],
    member: ['*:read', 'agents:run'],
    admin: ['*:read', 'agents:run', 'users:write'],
  },
};
const CATALOG_DISABLED = { enabled: false, permissions: [], rolePresets: {} };

describe('Users: permission catalog gating (free tier vs RBAC)', () => {
  it('enabled:false → no permission checkbox editor and no per-row Edit button (existing role-only UI stays)', async () => {
    mockFetch([
      route('/capabilities', 'GET', CAPS),
      route('/me', 'GET', ME),
      route('/organizations', 'GET', { organizations: [] }),
      route('/permissions/catalog', 'GET', CATALOG_DISABLED),
      route('/users', 'GET', { users: [{ id: 'u1', email: 'a@b.com', roles: ['viewer'] }] }),
    ]);
    wrap(<Users />);
    await waitFor(() => expect(screen.getByText('Users (1)')).toBeTruthy());
    // The role select from before this feature is still there…
    expect(screen.getByLabelText('Role')).toBeTruthy();
    // …but nothing permission-related is rendered.
    expect(screen.queryByText('Permissions')).toBeNull();
    expect(screen.queryByTitle('Edit role & permissions')).toBeNull();
  });
});

describe('Users: CreateUser permission editor (catalog enabled)', () => {
  it('picking a role seeds the checkboxes from rolePresets[role]', async () => {
    mockFetch([
      route('/capabilities', 'GET', CAPS),
      route('/me', 'GET', ME),
      route('/organizations', 'GET', { organizations: [] }),
      route('/permissions/catalog', 'GET', CATALOG),
      route('/users', 'GET', { users: [] }),
    ]);
    wrap(<Users />);
    await waitFor(() => expect(screen.getByText('Permissions')).toBeTruthy());
    // default role is 'viewer' → only '*:read' is pre-checked.
    expect((screen.getByLabelText('View runs & data') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Run agents') as HTMLInputElement).checked).toBe(false);

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'member' } });
    await waitFor(() => expect((screen.getByLabelText('Run agents') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText('Manage users') as HTMLInputElement).checked).toBe(false);
  });

  it('untouched checkboxes → permissions is OMITTED from POST /users (pure role, server applies role defaults)', async () => {
    mockFetch([
      route('/capabilities', 'GET', CAPS),
      route('/me', 'GET', ME),
      route('/organizations', 'GET', { organizations: [] }),
      route('/permissions/catalog', 'GET', CATALOG),
      route('/users', 'GET', { users: [] }),
      route('/users', 'POST', { ok: true, user: { id: 'x', roles: ['member'] }, token: 'tok_1' }),
    ]);
    wrap(<Users />);
    await waitFor(() => expect(screen.getByText('Permissions')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'member' } });
    await waitFor(() => expect((screen.getByLabelText('Run agents') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(postCall('/users')).toBeTruthy());
    const body = JSON.parse(postCall('/users')![1].body);
    expect(body.roles).toEqual(['member']);
    expect(body.permissions).toBeUndefined();
  });

  it('toggling a checkbox → the edited set is sent explicitly as permissions[] on POST /users', async () => {
    mockFetch([
      route('/capabilities', 'GET', CAPS),
      route('/me', 'GET', ME),
      route('/organizations', 'GET', { organizations: [] }),
      route('/permissions/catalog', 'GET', CATALOG),
      route('/users', 'GET', { users: [] }),
      route('/users', 'POST', { ok: true, user: { id: 'x', roles: ['viewer'] }, token: 'tok_2' }),
    ]);
    wrap(<Users />);
    await waitFor(() => expect(screen.getByText('Permissions')).toBeTruthy());
    // role stays 'viewer' (default); manually tick 'Run agents' on top of the seeded '*:read'.
    fireEvent.click(screen.getByLabelText('Run agents'));
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(postCall('/users')).toBeTruthy());
    const body = JSON.parse(postCall('/users')![1].body);
    expect(body.roles).toEqual(['viewer']);
    expect([...body.permissions].sort()).toEqual(['*:read', 'agents:run']);
  });
});

describe('Users: EditUser dialog (catalog enabled)', () => {
  it('pre-fills from the user, and PATCH /users/:id carries roles + the edited permissions[]', async () => {
    const existing = { id: 'bob@x.com', email: 'bob@x.com', roles: ['viewer'] }; // no explicit override yet
    mockFetch([
      route('/capabilities', 'GET', CAPS),
      route('/me', 'GET', ME),
      route('/organizations', 'GET', { organizations: [] }),
      route('/permissions/catalog', 'GET', CATALOG),
      route('/users', 'GET', { users: [existing] }),
      route(/\/users\/.+/, 'PATCH', { ok: true, user: { ...existing, roles: ['member'], permissions: ['*:read', 'agents:run'] } }),
    ]);
    wrap(<Users />);
    await waitFor(() => expect(screen.getByText('bob@x.com')).toBeTruthy());
    fireEvent.click(screen.getByTitle('Edit role & permissions'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText("Edit 'bob@x.com'")).toBeTruthy();
    // No prior override → no "reset" affordance yet, and checkboxes reflect the CURRENT role's preset.
    expect(within(dialog).queryByText('Reset to role defaults')).toBeNull();
    expect((within(dialog).getByLabelText('View runs & data') as HTMLInputElement).checked).toBe(true);

    // Switch role in the dialog → re-seeds from the new role's preset (a role switch ALONE, with no
    // checkbox touched, stays "pure role" — same untouched-checkbox rule as CreateUser).
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'member' } });
    await waitFor(() => expect((within(dialog).getByLabelText('Run agents') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(within(dialog).getByText('Save'));
    await waitFor(() => expect(postCall('/users/bob%40x.com', 'PATCH')).toBeTruthy());
    const firstBody = JSON.parse(postCall('/users/bob%40x.com', 'PATCH')![1].body);
    expect(firstBody.roles).toEqual(['member']);
    expect(firstBody.permissions).toBeUndefined(); // untouched → no override sent, server applies 'member' defaults

    // Re-open (the dialog closes after a successful save) and actually customize a checkbox this time
    // → the edited set is sent explicitly.
    fireEvent.click(screen.getByTitle('Edit role & permissions'));
    const dialog2 = await screen.findByRole('dialog');
    fireEvent.click(within(dialog2).getByLabelText('Run agents')); // '*:read' is the viewer-preset seed; add 'agents:run' on top
    fireEvent.click(within(dialog2).getByText('Save'));
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([u, init]: any[]) => String(u).endsWith('/users/bob%40x.com') && init?.method === 'PATCH',
      );
      expect(calls.length).toBe(2);
    });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([u, init]: any[]) => String(u).endsWith('/users/bob%40x.com') && init?.method === 'PATCH',
    );
    const secondBody = JSON.parse(calls[1][1].body);
    expect(secondBody.roles).toEqual(['viewer']); // GET /users still returns the original fixture (role unchanged server-side in this mock)
    expect([...secondBody.permissions].sort()).toEqual(['*:read', 'agents:run']);
  });

  it('an existing explicit override can be cleared → PATCH sends permissions: []', async () => {
    const existing = { id: 'carol@x.com', email: 'carol@x.com', roles: ['member'], permissions: ['*:read', 'agents:run', 'users:write'] };
    mockFetch([
      route('/capabilities', 'GET', CAPS),
      route('/me', 'GET', ME),
      route('/organizations', 'GET', { organizations: [] }),
      route('/permissions/catalog', 'GET', CATALOG),
      route('/users', 'GET', { users: [existing] }),
      route(/\/users\/.+/, 'PATCH', { ok: true, user: { ...existing, permissions: undefined } }),
    ]);
    wrap(<Users />);
    await waitFor(() => expect(screen.getByText('carol@x.com')).toBeTruthy());
    fireEvent.click(screen.getByTitle('Edit role & permissions'));
    const dialog = await screen.findByRole('dialog');
    // A pre-existing override → the checkbox that's NOT in the role preset (extra grant) is checked…
    expect((within(dialog).getByLabelText('Manage users') as HTMLInputElement).checked).toBe(true);
    // …and the reset affordance is offered.
    fireEvent.click(within(dialog).getByText('Reset to role defaults'));
    fireEvent.click(within(dialog).getByText('Save'));
    await waitFor(() => expect(postCall('/users/carol%40x.com', 'PATCH')).toBeTruthy());
    const body = JSON.parse(postCall('/users/carol%40x.com', 'PATCH')![1].body);
    expect(body.roles).toEqual(['member']);
    expect(body.permissions).toEqual([]);
  });
});

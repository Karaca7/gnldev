// SSE ticket (audit #2): instead of EventSource ?token=, an authenticated POST /auth/sse-ticket
// issues a short-lived (60s) SINGLE-USE ticket; GET /events?ticket= consumes it immediately. The
// existing ?token= behavior is verified separately in auth-org.test.ts — only the new ticket flow
// is tested here.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const AUTH = () => roleAuth({ viewer: { token: 'viw' }, admin: { token: 'adm' } });

describe('@gnldev/studio SSE ticket', () => {
  it('an unauthorized request cannot get a ticket (401)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH() });
    expect((await call(app, '/auth/sse-ticket', { method: 'POST' })).status).toBe(401);
  });

  it('issue → use it via /events?ticket= (200) → a second use is rejected (401)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH() });

    const issued = await call(app, '/auth/sse-ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer viw' },
    });
    expect(issued.status).toBe(200);
    const { ticket, expiresAt } = await issued.json();
    expect(typeof ticket).toBe('string');
    expect(ticket.length).toBeGreaterThan(0);
    expect(typeof expiresAt).toBe('number');

    const ok = await call(app, `/events?ticket=${ticket}`);
    expect(ok.status).toBe(200);
    await ok.body?.cancel(); // close the infinite SSE stream

    const reused = await call(app, `/events?ticket=${ticket}`);
    expect(reused.status).toBe(401);
  });

  it('an unknown/fabricated ticket is rejected (401)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH() });
    expect((await call(app, '/events?ticket=not-a-real-ticket')).status).toBe(401);
  });

  it('the ticket is rejected after the TTL (60s)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH() });
    const real = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(real);

    const issued = await call(app, '/auth/sse-ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer viw' },
    });
    const { ticket } = await issued.json();

    nowSpy.mockReturnValue(real + 61_000); // the TTL (60_000ms) was exceeded
    const expired = await call(app, `/events?ticket=${ticket}`);
    expect(expired.status).toBe(401);
  });

  it('existing ?token= behavior is NOT AFFECTED by adding the ticket', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: AUTH() });
    const ok = await call(app, '/events?token=viw');
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    expect((await call(app, '/events?token=wrong')).status).toBe(401);
  });

  it('if auth is off (no provider), a ticket can be freely issued and used', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const issued = await call(app, '/auth/sse-ticket', { method: 'POST' });
    expect(issued.status).toBe(200);
    const { ticket } = await issued.json();
    const ok = await call(app, `/events?ticket=${ticket}`);
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
  });
});

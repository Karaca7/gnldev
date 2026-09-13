// The admin panel itself was the one HTML route with no framing or content policy on it.
//
// `/swagger` got both headers when its supply-chain problem was fixed; the SPA — which holds the
// bearer token in localStorage and where a single click purges a run, promotes a managed agent or
// approves a pending tool call — was served with a bare `c.html(...)`. A page anywhere else could put
// it in an invisible frame and harvest those clicks.
//
// The `img-src` half is the deployment-level counterpart to the renderer fix in @gnldev/studio-ui:
// model output can name any address, and an <img> fetches without a click. Holding it here as well
// means a future renderer cannot quietly reopen the channel.
import { describe, it, expect } from 'vitest';
import type { Hono } from 'hono';

const app = async () => {
  const { createStudioApp } = await import('../src/server.js');
  return createStudioApp({
    reader: { listRuns: async () => [], readRun: async () => [] } as any,
  }) as unknown as Hono;
};

describe('the admin SPA is served with a framing and image policy', () => {
  it('frame-ancestors and X-Frame-Options are real headers on the panel route', async () => {
    const res = await (await app()).fetch(new Request('http://s/'));
    // The SPA is only mounted when studio-ui's dist is present; without it there is no page to
    // protect and this assertion would be measuring the 404 instead.
    expect(res.status, 'precondition: the SPA route is mounted').toBe(200);

    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    // In <meta> form these directives are defined to be ignored — the same trap `/swagger` hit — so
    // what matters is that they arrive as headers.
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('img-src permits only same-origin and data: — no address the model chose', async () => {
    const csp = (await (await app()).fetch(new Request('http://s/'))).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("img-src 'self' data:");
    expect(csp, 'a wildcard here would undo the renderer fix').not.toMatch(/img-src[^;]*\*/);
  });
});

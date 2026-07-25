// @vitest-environment jsdom
// Scope: the eval-gate (412) rich score table in Agents.tsx's promote flow.
// On 412 the server returns { error, aggregate } (server.ts ~L1721-1739). API-05: ApiError now
// carries the whole parsed JSON body (see api.ts's http()), so Agents.tsx reads `aggregate` straight
// off `e.body` via the normal api.promoteAgentVersion() call — verified here.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n'; // EN default language — so Agents' t() calls use the real translation.
import { Agents, parseGateScores } from '../src/views/Agents';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

function jsonOk(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
}

/** POST to the promote endpoint → 412 + { error, aggregate }; other endpoints (capabilities/agents/managed-agents) ok:true. */
function stubFetchWithGateRejection(aggregate: Record<string, number>, message: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/promote') && init?.method === 'POST') {
      const body = { error: message, aggregate };
      return {
        ok: false, status: 412, statusText: 'Precondition Failed',
        headers: { get: () => 'application/json' },
        json: async () => body,
        clone() { return this; }, // http() reads the error body via res.clone().json()
      };
    }
    if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true, evalGate: true });
    if (u.endsWith('/agents')) return jsonOk([{ name: 'yazar', model: 'anthropic/claude-3', hasTools: false }]);
    if (u.endsWith('/managed-agents')) {
      return jsonOk({
        agents: [{
          name: 'yazar', active: 1,
          versions: [
            { version: 1, model: 'anthropic/claude-3', createdAt: 1 },
            { version: 2, model: 'anthropic/claude-3', createdAt: 2 },
          ],
        }],
      });
    }
    return jsonOk([]);
  }));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('parseGateScores (pure function)', () => {
  it('extracts the FAILING scorers and the threshold from the message, and flags PASSING scorers in aggregate against the threshold too', () => {
    const rows = parseGateScores(
      'eval gate FAILED: helpfulness=0.30<0.50 — promote rejected',
      { helpfulness: 0.3, accuracy: 0.9 },
    );
    expect(rows).toEqual([
      { scorer: 'accuracy', score: 0.9, threshold: 0.5, passed: true },
      { scorer: 'helpfulness', score: 0.3, threshold: 0.5, passed: false },
    ]);
  });

  it('catches all scorers when there are multiple FAILING ones', () => {
    const rows = parseGateScores(
      'eval gate FAILED: helpfulness=0.30<0.50, accuracy=0.40<0.50 — promote rejected',
      { helpfulness: 0.3, accuracy: 0.4, tone: 0.95 },
    );
    expect(rows.map((r) => [r.scorer, r.passed])).toEqual([
      ['accuracy', false],
      ['helpfulness', false],
      ['tone', true],
    ]);
  });

  it('falls back to the default 0.5 threshold when the message has no match (unexpected format); nothing is flagged as failing', () => {
    const rows = parseGateScores('unknown error format', { a: 0.9 });
    expect(rows).toEqual([{ scorer: 'a', score: 0.9, threshold: 0.5, passed: true }]);
  });

  it('sorts results alphabetically by scorer name', () => {
    const rows = parseGateScores('x', { zeta: 0.9, alpha: 0.9 });
    expect(rows.map((r) => r.scorer)).toEqual(['alpha', 'zeta']);
  });
});

describe('Agents: promote eval-gate (412) UI', () => {
  it('when evalGate is on, the "subject to eval gate" badge appears on the panel', async () => {
    stubFetchWithGateRejection({ helpfulness: 0.3 }, 'eval gate FAILED: helpfulness=0.30<0.50 — promote rejected');
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('yazar')).toBeTruthy());
    expect(screen.getByText('subject to eval gate')).toBeTruthy();
  });

  it('when promote is rejected with 412, shows a score table instead of a single line (passing+failing scorers, threshold, status badge)', async () => {
    stubFetchWithGateRejection(
      { helpfulness: 0.3, accuracy: 0.9 },
      'eval gate FAILED: helpfulness=0.30<0.50 — promote rejected',
    );
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('yazar')).toBeTruthy());
    // v2 draft → "Promote" button (v1 is already active, not a rollback). Selected by button ROLE so it
    // doesn't collide with the "Promote" TEXT in the guide panel.
    const promoteBtn = await screen.findByRole('button', { name: /Promote/ });
    fireEvent.click(promoteBtn);

    // FLOW-11: promote no longer fires on click — it opens a confirm dialog first (old/new version
    // shown together). Confirming it is what actually triggers the request.
    const confirmBtn = await screen.findByRole('button', { name: /Yes, promote/ });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(screen.getByText('helpfulness')).toBeTruthy());
    expect(screen.getByText('accuracy')).toBeTruthy();
    expect(screen.getByText('0.30')).toBeTruthy();
    expect(screen.getByText('0.90')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy(); // helpfulness did not clear the threshold
    expect(screen.getByText('passed')).toBeTruthy(); // accuracy cleared the threshold
    expect(screen.getByText(/eval gate FAILED/)).toBeTruthy();

    // Did the POST actually go to /promote (regression: does the raw fetch path hit the right endpoint)?
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const post = calls.find(([u, init]: any[]) => String(u).endsWith('/managed-agents/yazar/promote') && init?.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse((post![1] as any).body)).toEqual({ version: 2 });
  });
});

/** POST to the promote endpoint → 200 success (no eval gate involved); other endpoints (capabilities/agents/managed-agents) ok:true. */
function stubFetchPromoteSuccess() {
  const calls: { url: string; method?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method });
    if (u.endsWith('/promote') && init?.method === 'POST') return jsonOk({ ok: true, name: 'yazar', active: 2, previous: 1 });
    if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true, evalGate: false });
    if (u.endsWith('/agents')) return jsonOk([{ name: 'yazar', model: 'anthropic/claude-3', hasTools: false }]);
    if (u.endsWith('/managed-agents')) {
      return jsonOk({
        agents: [{
          name: 'yazar', active: 1,
          versions: [
            { version: 1, model: 'anthropic/claude-3', createdAt: 1 },
            { version: 2, model: 'anthropic/claude-3', createdAt: 2 },
          ],
        }],
      });
    }
    return jsonOk([]);
  }));
  return calls;
}

describe('FLOW-11: promote requires confirmation (no more fire-on-click)', () => {
  it('clicking Promote opens a confirm dialog FIRST — no request is sent until the dialog is confirmed; the dialog names old+new version', async () => {
    const calls = stubFetchPromoteSuccess();
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('yazar')).toBeTruthy());

    const promoteBtn = await screen.findByRole('button', { name: /Promote/ });
    fireEvent.click(promoteBtn);

    // Dialog surfaces BOTH the target version (2) and the currently-active one (1) together — so a
    // wrong-row click is caught here instead of silently repointing prod.
    await waitFor(() => expect(screen.getByText(/v2 → prod \(currently v1\)/)).toBeTruthy());
    expect(calls.some((c) => c.url.endsWith('/promote'))).toBe(false); // not sent yet

    const confirmBtn = await screen.findByRole('button', { name: /Yes, promote/ });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/managed-agents/yazar/promote') && c.method === 'POST')).toBe(true));
  });

  it('canceling the confirm dialog does NOT send a promote request', async () => {
    const calls = stubFetchPromoteSuccess();
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('yazar')).toBeTruthy());

    const promoteBtn = await screen.findByRole('button', { name: /Promote/ });
    fireEvent.click(promoteBtn);
    await screen.findByRole('button', { name: /Yes, promote/ });

    fireEvent.click(screen.getByText('Cancel').closest('button')!);

    await waitFor(() => expect(screen.queryByRole('button', { name: /Yes, promote/ })).toBeNull());
    expect(calls.some((c) => c.url.endsWith('/promote'))).toBe(false);
  });
});

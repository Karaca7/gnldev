// @vitest-environment jsdom
// Scope: the eval-gate (412) rich score table in Agents.tsx's promote flow.
// On 412 the server returns { error, aggregate } (server.ts ~L1721-1739); api.ts's http() only puts
// `.error` into ApiError.message, `aggregate` is lost (see api.ts ~L165-186). Agents.tsx bypasses this
// and captures `aggregate` with a raw fetch (promoteWithGateInfo) — verified here.
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
      return {
        ok: false, status: 412, statusText: 'Precondition Failed',
        headers: { get: () => 'application/json' },
        json: async () => ({ error: message, aggregate }),
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

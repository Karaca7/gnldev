// @vitest-environment jsdom
// Networks view: was rendered by nothing (0% coverage). Two halves here — (1) buildAgentGraph, the
// pure A2A-edges → nodes/edges layout (dedup, root detection, BFS layering, cycle guard), and
// (2) the view's non-graph states plus the call-edges list, which is the only NUMERIC view of the
// data. The rendered xyflow canvas stays a browser check, as in network-view.test.tsx.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Networks, buildAgentGraph } from '../src/views/Networks';

// Re-stubbed per test: afterEach's unstubAllGlobals also clears these, and xyflow constructs a
// ResizeObserver on mount — without this the SECOND render in this file throws.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const edge = (parentRunId: string, remoteAgent: string) => ({ parentRunId, remoteAgent }) as any;

describe('buildAgentGraph (pure)', () => {
  it('no edges → no nodes (the view shows its empty state instead)', () => {
    expect(buildAgentGraph([])).toEqual({ nodes: [], edges: [] });
  });

  it('every unique name becomes exactly one node, even when it appears many times', () => {
    const g = buildAgentGraph([edge('router', 'billing'), edge('router', 'support'), edge('billing', 'support')]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['billing', 'router', 'support']);
  });

  it('repeated calls between the same pair collapse into ONE edge (dedup by parent→remote)', () => {
    const g = buildAgentGraph([edge('a', 'b'), edge('a', 'b'), edge('a', 'b')]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.id).toBe('a→b');
    expect(g.edges[0]!.source).toBe('a');
    expect(g.edges[0]!.target).toBe('b');
  });

  it('a node with no incoming call is a root and is flagged for the accent style', () => {
    const g = buildAgentGraph([edge('router', 'billing')]);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect((byId.router!.data as any).root).toBe(true);
    expect((byId.billing!.data as any).root).toBe(false);
  });

  it('depth is the LONGEST path, so a child never sits above its parent', () => {
    // router → mid → leaf, and also router → leaf directly: leaf must take the deeper level (2), not 1
    const g = buildAgentGraph([edge('router', 'mid'), edge('mid', 'leaf'), edge('router', 'leaf')]);
    const y = Object.fromEntries(g.nodes.map((n) => [n.id, n.position.y]));
    expect(y.router).toBe(0);
    expect(y.mid!).toBeGreaterThan(y.router!);
    expect(y.leaf!).toBeGreaterThan(y.mid!);
  });

  it('siblings on a layer are centered around x=0', () => {
    const g = buildAgentGraph([edge('root', 'a'), edge('root', 'b')]);
    const xs = g.nodes.filter((n) => n.id !== 'root').map((n) => n.position.x).sort((p, q) => p - q);
    expect(xs).toHaveLength(2);
    expect(xs[0]! + xs[1]!).toBe(0); // symmetric around the center
    expect(g.nodes.find((n) => n.id === 'root')!.position.x).toBe(0);
  });

  it('a pure CYCLE (no root at all) still produces a finite graph — the guard holds', () => {
    const g = buildAgentGraph([edge('a', 'b'), edge('b', 'a')]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(g.edges).toHaveLength(2);
    for (const n of g.nodes) expect(Number.isFinite(n.position.y)).toBe(true);
  });

  it('a self-call does not hang and yields a single node', () => {
    const g = buildAgentGraph([edge('solo', 'solo')]);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(1);
  });

  it('nodes are not draggable or selectable (the graph is a read-only picture)', () => {
    const g = buildAgentGraph([edge('a', 'b')]);
    for (const n of g.nodes) {
      expect(n.draggable).toBe(false);
      expect(n.selectable).toBe(false);
      expect(n.type).toBe('pill');
    }
  });
});

function stubFetch(body: unknown, opts: { ok?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.ok === false ? 500 : 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  })));
}
function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('Networks view', () => {
  it('no A2A edges → empty state, no graph card', async () => {
    stubFetch([]);
    wrap(<Networks />);
    await waitFor(() => expect(screen.queryByText('router')).toBeNull());
    expect(document.querySelector('.react-flow')).toBeNull();
  });

  it('with edges the graph card mounts and the call-edges list shows real counts', async () => {
    stubFetch([
      { parentRunId: 'router', remoteAgent: 'billing' },
      { parentRunId: 'router', remoteAgent: 'billing' },
      { parentRunId: 'router', remoteAgent: 'support' },
    ]);
    wrap(<Networks />);
    // the list is the numeric view: billing was called twice, support once, sorted by call count
    await waitFor(() => expect(screen.getAllByText(/billing/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/support/).length).toBeGreaterThan(0);
    // real counts, not a mocked latency: router→billing happened twice, router→support once
    expect(screen.getByText(/^2\s+call/i)).toBeTruthy();
    expect(screen.getByText(/^1\s+call/i)).toBeTruthy();
  });
});

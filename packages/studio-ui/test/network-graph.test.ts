// Pure transform test: routes/steps (server getNetworkTrace) → flat node/edge list.
// NOT DEPENDENT on xyflow/dagre — only buildNetworkGraph as exported by Inspector.tsx.
import { describe, it, expect } from 'vitest';
import { buildNetworkGraph } from '../src/views/Inspector';
import type { NetworkTrace } from '../src/api';

describe('buildNetworkGraph (Network tab — pure transform)', () => {
  it('empty trace: only the router node, no edges', () => {
    const { nodes, edges } = buildNetworkGraph({ routes: [], steps: [] });
    expect(nodes).toEqual([{ id: 'router', label: 'router', kind: 'router' }]);
    expect(edges).toEqual([]);
  });

  it('links a route → route → final chain in order (by i, final always last)', () => {
    const trace: NetworkTrace = {
      routes: [
        { i: 1, decision: { action: 'route', agent: 'researcher', task: 'search' } },
        { i: 'final', decision: { action: 'final', answer: 'done' } },
        { i: 0, decision: { action: 'route', agent: 'planner', task: 'plan' } },
      ],
      steps: [
        { i: 0, agent: 'planner', task: 'plan', text: 'plan text' },
        { i: 1, agent: 'researcher', task: 'search', text: 'research text' },
      ],
    };
    const { nodes, edges } = buildNetworkGraph(trace);

    expect(nodes.map((n) => n.id)).toEqual(['router', 'agent:0', 'agent:1', 'final']);
    expect(nodes[1]).toMatchObject({ kind: 'agent', label: 'planner', task: 'plan' });
    expect(nodes[2]).toMatchObject({ kind: 'agent', label: 'researcher', task: 'search' });
    expect(nodes[3]).toMatchObject({ kind: 'final', label: 'final answer', answer: 'done' });

    // Chain: router -> agent:0 -> agent:1 -> final (each step continues from the previous one).
    expect(edges).toEqual([
      { id: 'e0', source: 'router', target: 'agent:0', label: 'turn 0' },
      { id: 'e1', source: 'agent:0', target: 'agent:1', label: 'turn 1' },
      { id: 'e2', source: 'agent:1', target: 'final' },
    ]);
  });

  it('final only (no routes at all): router connects directly to final', () => {
    const trace: NetworkTrace = {
      routes: [{ i: 'final', decision: { action: 'final', answer: 'direct answer' } }],
      steps: [],
    };
    const { nodes, edges } = buildNetworkGraph(trace);
    expect(nodes.map((n) => n.id)).toEqual(['router', 'final']);
    expect(edges).toEqual([{ id: 'e0', source: 'router', target: 'final' }]);
  });

  it('routes only, no final decision: the chain ends at the last agent', () => {
    const trace: NetworkTrace = {
      routes: [{ i: 0, decision: { action: 'route', agent: 'a', task: 't' } }],
      steps: [{ i: 0, agent: 'a', task: 't', text: 'x' }],
    };
    const { nodes, edges } = buildNetworkGraph(trace);
    expect(nodes.map((n) => n.id)).toEqual(['router', 'agent:0']);
    expect(edges).toEqual([{ id: 'e0', source: 'router', target: 'agent:0', label: 'turn 0' }]);
  });
});

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Network } from 'lucide-react';
import { ReactFlow, Handle, Position, type Node, type Edge, type NodeProps } from '@xyflow/react';
import { useA2A, type A2AEdge } from '../api';
import { Spinner, EmptyState, ErrorBox, cn } from '../components';

/** Pill node (exact mockup match): a colored dot on the left + the agent name in monospace. Root
    agents (ones with no incoming call) get the brand/lime accent, others get the neutral `info` dot. */
function PillNode({ data }: NodeProps) {
  const root = Boolean((data as { root?: boolean }).root);
  return (
    <div className={cn('flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs',
      root ? 'border-brand bg-brand/10' : 'border-border bg-card')}>
      <Handle type="target" position={Position.Top} className="!h-0 !w-0 !min-w-0 !border-0 !bg-transparent" />
      <span className={cn('h-2 w-2 shrink-0 rounded-full', root ? 'bg-brand' : 'bg-info')} />
      <span className="font-mono text-foreground">{String((data as { label?: string }).label ?? '')}</span>
      <Handle type="source" position={Position.Bottom} className="!h-0 !w-0 !min-w-0 !border-0 !bg-transparent" />
    </div>
  );
}
const nodeTypes = { pill: PillNode };

/** Build an agent graph from A2A edges: every unique name = one node, parent → remote directed edge.
    Layout: layer via BFS from the roots (no incoming call); each layer is horizontally centered. */
function build(edges: A2AEdge[]): { nodes: Node[]; edges: Edge[] } {
  const names = new Set<string>();
  const incoming = new Set<string>();
  const adj = new Map<string, string[]>();
  const pairSeen = new Set<string>();
  const outEdges: Edge[] = [];
  for (const e of edges) {
    names.add(e.parentRunId); names.add(e.remoteAgent); incoming.add(e.remoteAgent);
    const key = `${e.parentRunId}→${e.remoteAgent}`;
    if (!pairSeen.has(key)) {
      pairSeen.add(key);
      (adj.get(e.parentRunId) ?? adj.set(e.parentRunId, []).get(e.parentRunId)!).push(e.remoteAgent);
      // A plain diagonal, unlabeled, arrowless thin edge (exact mockup match): no bezier curve/status/animation.
      outEdges.push({ id: key, source: e.parentRunId, target: e.remoteAgent, type: 'straight',
        style: { stroke: 'hsl(var(--border))', strokeWidth: 1.25 } });
    }
  }
  // Layer via BFS (the longest path = a lower level → children stay below their parent).
  const level = new Map<string, number>();
  const roots = [...names].filter((n) => !incoming.has(n));
  const queue = roots.length ? roots.slice() : [...names].slice(0, 1);
  queue.forEach((n) => level.set(n, 0));
  let guard = 0;
  while (queue.length && guard++ < 10000) {
    const n = queue.shift()!;
    for (const c of adj.get(n) ?? []) {
      const nl = (level.get(n) ?? 0) + 1;
      if (!level.has(c) || nl > level.get(c)!) { level.set(c, nl); queue.push(c); }
    }
  }
  for (const n of names) if (!level.has(n)) level.set(n, 0);
  const byLevel = new Map<number, string[]>();
  for (const n of [...names].sort()) { const l = level.get(n)!; (byLevel.get(l) ?? byLevel.set(l, []).get(l)!).push(n); }
  const SX = 210, SY = 130;
  const nodes: Node[] = [];
  for (const [l, ns] of byLevel) {
    const startX = -((ns.length - 1) * SX) / 2;
    ns.forEach((n, i) => {
      nodes.push({ id: n, type: 'pill', position: { x: startX + i * SX, y: l * SY },
        data: { label: n, root: !incoming.has(n) }, draggable: false, selectable: false });
    });
  }
  return { nodes, edges: outEdges };
}

export function Networks() {
  const { t } = useTranslation('networks');
  const a2a = useA2A();
  const { nodes, edges } = useMemo(() => build(a2a.data ?? []), [a2a.data]);
  // Call edges: aggregate parent → remote relationships by their REAL call count (each A2AEdge = one call).
  // Per-edge latency isn't tracked, so the mockup's "0.4s" mock value isn't shown — no making things up.
  const callEdges = useMemo(() => {
    const m = new Map<string, { source: string; target: string; calls: number }>();
    for (const e of a2a.data ?? []) {
      const key = `${e.parentRunId}→${e.remoteAgent}`;
      const cur = m.get(key) ?? { source: e.parentRunId, target: e.remoteAgent, calls: 0 };
      cur.calls++; m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.calls - a.calls);
  }, [a2a.data]);
  if (a2a.isLoading) return <Spinner />;
  if (a2a.error) return <ErrorBox error={a2a.error} />;
  if (!a2a.data?.length) return <EmptyState icon={Network} title={t('emptyTitle')} description={t('emptyDescription')} />;
  return (
    // D3-5: below md the graph and the call-edges list used to compete for the same viewport — the
    // list was `hidden` outright, silently deleting the only numeric view of the data (no back-arrow
    // or alternate view like Tools/Mcp have). Fix: stack list BELOW the graph on mobile (single natural
    // page scroll, inherited from App's `<main>` overflow-auto wrapper) instead of a toggle — a toggle
    // would show/hide the ReactFlow container itself, and resizing/remounting its box after `fitView`
    // already ran is the riskier path. At md+ this is unchanged: fixed-height row, graph flex-1, list
    // in its own scrollable aside.
    <div className="flex flex-col gap-4 p-4 md:h-full md:flex-row">
      {/* Graph card: a clean dark card (no minimap/controls/dot-background — exact mockup match).
          Fixed viewport-relative height on mobile (so ReactFlow has a stable box to fitView into);
          at md+ it stretches to fill the row via flex-1, exactly as before. */}
      <div className="h-[50vh] min-h-[320px] min-w-0 shrink-0 overflow-hidden rounded-xl border border-border bg-surface-1 md:h-auto md:flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll={false}
          minZoom={0.4}
          maxZoom={1.4}
        />
      </div>
      {/* Call edges card (the mockup's right-hand panel): every source → target relationship + its real
          call count. Always in the DOM now (full width, stacked below the graph on mobile); at md+ it
          reverts to the original fixed-width side panel with its own internal scroll. */}
      <aside className="w-full shrink-0 overflow-auto rounded-xl border border-border bg-surface-1 p-4 md:w-80">
        <div className="mb-4 font-medium text-foreground">{t('callEdgesTitle')}</div>
        <div className="space-y-4">
          {callEdges.map((e) => (
            <div key={`${e.source}-${e.target}`}>
              <div className="flex items-center gap-1.5 font-mono text-xs">
                <span className="truncate text-muted-foreground">{e.source}</span>
                <span className="shrink-0 text-brand">&rarr;</span>
                <span className="truncate font-medium text-foreground">{e.target}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">{t('callCount', { count: e.calls })}</div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plug, ChevronLeft } from 'lucide-react';
import { useMcp } from '../api';
import { Spinner, EmptyState, ErrorBox, Badge, StatStrip, JsonBlock, cn } from '../components';

/** MCP servers: a master-detail — the server LIST (left) + the selected server's TOOLS (right). Click a
    server to inspect its tools (name · description · input schema). A stat strip summarizes servers/tools. */
export function Mcp() {
  const { t } = useTranslation('mcp');
  const mcp = useMcp();
  const [sel, setSel] = useState<string | null>(null);
  if (mcp.isLoading) return <Spinner />;
  // Query error (SEPARATE from the "no servers" empty state): a fetch failure must not read as "no servers".
  if (mcp.error) return <ErrorBox error={mcp.error} />;
  if (!mcp.data?.length) return <EmptyState icon={Plug} title={t('emptyTitle')} description={t('emptyDescription')} />;
  const servers = mcp.data;
  const active = servers.find((s) => s.id === sel) ?? servers[0];
  const totalTools = servers.reduce((n, s) => n + s.tools.length, 0);
  return (
    <div className="flex h-full flex-col">
      <StatStrip items={[
        { label: t('statServers'), value: String(servers.length) },
        { label: t('statTools'), value: String(totalTools) },
      ]} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Master: server list. Below md it's the only panel until a server is tapped. */}
        <div className={cn('w-full flex-col overflow-auto border-r border-border p-1.5 md:flex md:w-60', sel ? 'hidden md:flex' : 'flex')}>
          {servers.map((s) => (
            <button
              key={s.id}
              onClick={() => setSel(s.id)}
              className={cn('mb-0.5 flex w-full items-center justify-between gap-2 rounded-md border-l-2 px-2.5 py-2 text-left transition-colors',
                active.id === s.id ? 'border-l-brand bg-muted' : 'border-l-transparent hover:bg-muted/60')}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Plug size={13} className="shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{s.name ?? s.id}</span>
              </span>
              {s.error ? <Badge tone="destructive">{t('errorBadge')}</Badge> : <Badge tone="info">{s.tools.length}</Badge>}
            </button>
          ))}
        </div>
        {/* Detail: the selected server's tools. Below md it replaces the list (back arrow returns). */}
        <div className={cn('flex-1 overflow-auto', !sel && 'hidden md:block')}>
          <div className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <button type="button" onClick={() => setSel(null)} className="shrink-0 text-muted-foreground hover:text-foreground md:hidden" title={t('backTitle')}>
                <ChevronLeft size={16} />
              </button>
              <Plug size={15} className="shrink-0 text-brand" />
              <h2 className="font-medium">{active.name ?? active.id}</h2>
              {active.error
                ? <Badge tone="destructive">{t('errorBadge')}</Badge>
                : <Badge tone="info">{t('toolCount', { count: active.tools.length })}</Badge>}
            </div>
            {active.error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{active.error}</div>
            ) : active.tools.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">{t('noTools')}</div>
            ) : (
              <div className="space-y-2">
                {active.tools.map((tool: any) => (
                  <div key={tool.name} className="rounded-md border border-border p-3">
                    <div className="font-mono text-sm font-medium text-foreground">{tool.name}</div>
                    {tool.description && <div className="mt-0.5 text-xs text-muted-foreground">{tool.description}</div>}
                    {tool.inputSchema && <div className="mt-2"><JsonBlock value={tool.inputSchema} max={400} /></div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

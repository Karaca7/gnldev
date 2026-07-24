import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type VectorMatch } from '../api';
import { Btn, Spinner, Empty, Badge, JsonBlock } from '../components';

const DEFAULT_TOP_K = 5;

// PURE function (testable): the minScore threshold is applied CLIENT-SIDE — the server /knowledge/search
// only takes { query, topK } (packages/studio/src/server.ts app.post('/knowledge/search', …), and
// the StudioVectors.search(query, topK) signature does NOT SUPPORT minScore). 0/undefined → no filter.
export function filterByMinScore(results: VectorMatch[], minScore: number): VectorMatch[] {
  if (!(minScore > 0)) return results;
  return results.filter((r) => r.score >= minScore);
}

// PURE functions (testable): clamp topK/minScore's raw text input into the [min,max] range.
// Clamping on every keystroke made the cursor jump and blocked entering intermediate values
// (e.g. typing "1" when aiming for "10") — now it's only called on blur/submit, the raw string is kept while typing.
export function clampTopK(raw: string): number {
  if (raw.trim() === '') return DEFAULT_TOP_K;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_TOP_K;
  return Math.min(50, Math.max(1, n));
}
export function clampMinScore(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Knowledge: vector store search (embed(query) → store.query). Makes RAG retrieval visible.
export function Knowledge() {
  const { t } = useTranslation('knowledge');
  const [q, setQ] = useState('');
  // Raw string state: freely editable while the user types; numeric clamp only on blur/submit.
  const [topKRaw, setTopKRaw] = useState(String(DEFAULT_TOP_K));
  const [minScoreRaw, setMinScoreRaw] = useState('0');
  const [results, setResults] = useState<VectorMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    const query = q.trim();
    if (!query || busy) return;
    const topK = clampTopK(topKRaw);
    const minScore = clampMinScore(minScoreRaw);
    setTopKRaw(String(topK));
    setMinScoreRaw(String(minScore));
    setBusy(true);
    setErr(null);
    try {
      const raw = await api.knowledgeSearch(query, topK);
      setResults(filterByMinScore(raw, minScore));
    } catch (e) {
      setErr(String(e));
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        {/* GNL Input recipe: lime "›" prefix + blinking caret, mono; lime border + glow ring on focus. */}
        <div className="flex min-w-[12rem] flex-1 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 transition-colors focus-within:border-brand focus-within:shadow-[0_0_0_3px_hsl(var(--brand)/0.12)]">
          <span aria-hidden className="select-none font-mono text-sm text-brand">›</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
            placeholder={t('searchPlaceholder')}
            className="flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
          />
          <span aria-hidden className="brand-caret" />
        </div>
        <label className="flex items-center gap-1 text-xs text-muted-foreground" title={t('topKTitle')}>
          topK
          <input
            aria-label="topK"
            type="number"
            min={1}
            max={50}
            value={topKRaw}
            onChange={(e) => setTopKRaw(e.target.value)}
            onBlur={() => setTopKRaw(String(clampTopK(topKRaw)))}
            className="w-14 rounded-md border border-input bg-background px-1.5 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground" title={t('minScoreTitle')}>
          minScore
          <input
            aria-label="minScore"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={minScoreRaw}
            onChange={(e) => setMinScoreRaw(e.target.value)}
            onBlur={() => setMinScoreRaw(String(clampMinScore(minScoreRaw)))}
            className="w-16 rounded-md border border-input bg-background px-1.5 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <Btn arrow onClick={run} disabled={busy || !q.trim()}>{t('searchAction')}</Btn>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {busy ? (
          <Spinner />
        ) : err ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">⚠ {err}</div>
        ) : results == null ? (
          <Empty>{t('emptyPrompt')}</Empty>
        ) : results.length === 0 ? (
          <Empty>{t('noResults')}</Empty>
        ) : (
          <ol className="space-y-2">
            {results.map((r) => (
              <li key={r.id} className="rounded-md border border-border p-2.5">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{r.id}</span>
                  <span className="ml-auto"><Badge tone="muted">{t('scoreLabel', { score: r.score.toFixed(3) })}</Badge></span>
                </div>
                <div className="whitespace-pre-wrap text-sm">{r.text}</div>
                {r.metadata && Object.keys(r.metadata).length > 0 && <div className="mt-1.5"><JsonBlock value={r.metadata} max={300} /></div>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

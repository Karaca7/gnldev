// Lightweight line diff (S4): dependency-free LCS-based diffLines + unified TextDiff component.
// Monaco was deliberately not adopted — it conflicts with GNL's small-bundle stance; UI text
// (model outputs) is small, so an O(n·m) DP is more than sufficient.
import { cn } from './components';

export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

/** If n·m exceeds this threshold, the DP is skipped (crude del+add fallback) — pathological input won't freeze the UI. */
const DP_CELL_LIMIT = 200_000;

/**
 * Line-based diff: returns the `a` → `b` transformation as same/del/add ops.
 * The common prefix/suffix is trimmed first (a typical model-output diff spans a few lines),
 * The remaining core is aligned via LCS. Deterministic; on ties, deletion comes first.
 */
export function diffLines(a: string, b: string): DiffOp[] {
  const la = a.split('\n');
  const lb = b.split('\n');

  // Trim the common prefix/suffix — shrinks the DP core.
  let pre = 0;
  while (pre < la.length && pre < lb.length && la[pre] === lb[pre]) pre++;
  let suf = 0;
  while (suf < la.length - pre && suf < lb.length - pre && la[la.length - 1 - suf] === lb[lb.length - 1 - suf]) suf++;

  const ca = la.slice(pre, la.length - suf);
  const cb = lb.slice(pre, lb.length - suf);
  const out: DiffOp[] = la.slice(0, pre).map((text) => ({ type: 'same' as const, text }));

  if (ca.length * cb.length > DP_CELL_LIMIT) {
    // Fallback: show the core as a block del+add (honest crudeness beats misaligning it).
    out.push(...ca.map((text) => ({ type: 'del' as const, text })));
    out.push(...cb.map((text) => ({ type: 'add' as const, text })));
  } else if (ca.length || cb.length) {
    // LCS length table (classic DP), then backtrack.
    const n = ca.length, m = cb.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i]![j] = ca[i] === cb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ca[i] === cb[j]) { out.push({ type: 'same', text: ca[i]! }); i++; j++; }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ type: 'del', text: ca[i]! }); i++; }
      else { out.push({ type: 'add', text: cb[j]! }); j++; }
    }
    while (i < n) out.push({ type: 'del', text: ca[i++]! });
    while (j < m) out.push({ type: 'add', text: cb[j++]! });
  }

  out.push(...la.slice(la.length - suf).map((text) => ({ type: 'same' as const, text })));
  return out;
}

const ROW_STYLE: Record<DiffOp['type'], string> = {
  same: 'text-muted-foreground',
  del: 'bg-destructive/10 text-destructive',
  add: 'bg-success/10 text-success',
};
const GUTTER: Record<DiffOp['type'], string> = { same: ' ', del: '−', add: '+' };

/**
 * Unified line-diff view. Renders nothing when there's no change (caller can use it unconditionally).
 * The data-diff-line attribute is a test/automation hook.
 */
export function TextDiff({ a, b, className }: { a: string; b: string; className?: string }) {
  const ops = diffLines(a, b);
  if (!ops.some((o) => o.type !== 'same')) return null;
  return (
    <div className={cn('overflow-x-auto rounded-md border border-border font-mono text-[11px] leading-relaxed', className)}>
      {ops.map((o, i) => (
        <div key={i} data-diff-line={o.type} className={cn('flex gap-2 whitespace-pre-wrap break-words px-2', ROW_STYLE[o.type])}>
          <span className="w-3 shrink-0 select-none text-center">{GUTTER[o.type]}</span>
          <span className="min-w-0 flex-1">{o.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

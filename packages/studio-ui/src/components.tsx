import type { ComponentType, KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { errMessage } from './api';

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

export function Btn({
  children, onClick, variant = 'default', size = 'sm', disabled, title, arrow, busy,
}: {
  children: ReactNode; onClick?: () => void;
  variant?: 'default' | 'primary' | 'outline' | 'ghost' | 'ok' | 'deny';
  size?: 'sm' | 'xs' | 'icon'; disabled?: boolean; title?: string;
  /** Optional "›" prefix icon used only on high-impact (primary) actions — decorative, aria-hidden.
      Suppressed while `busy` is true so the two indicators don't stack. */
  arrow?: boolean;
  /** Pending-action state: disables the button, sets aria-busy, and shows the same live-pulse
      dot used elsewhere (record-dot, see Spinner) in place of the arrow — no separate spinner glyph. */
  busy?: boolean;
}) {
  const base = 'inline-flex items-center gap-1.5 rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none';
  const sz = size === 'icon'
    ? 'h-[42px] w-[42px] justify-center p-0 text-base'
    : size === 'xs' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  // GNL component recipe — 5 real visual recipes behind 6 variant names: primary = Fluo Lime fill +
  // Ink text + Geist Bold (700); "default" is an alias for primary and also the prop default, so the
  // ~20 call sites that omit `variant` get this look for free. outline = Ink surface + border + Paper
  // text (neutral action — 25 call sites use this meaning; kept as the public name, "tertiary" was an
  // unused synonym and has been removed). ghost = just muted text ("text" recipe, 22 call sites). ok/deny
  // approve/reject pair is out of brand scope, kept since T1 ("secondary", an unused Neon Green outline
  // variant, has also been removed — 0 call sites).
  // bg-BRAND, not bg-primary. In the dark theme the two tokens hold the same hex (#b4ff00), so this
  // changes nothing there. In the light theme --brand is the deeper step (#445e08) and --primary the
  // lighter one (#6d970c) — the deeper one takes WHITE text at 7.33:1, which is the look we want,
  // while the lighter one only worked with near-black and read as mud. See --brand-foreground.
  const PRIMARY = 'bg-brand text-brand-foreground hover:bg-brand/90 font-bold';
  const OUTLINE = 'border border-border bg-transparent text-foreground hover:bg-muted font-medium';
  const v = {
    default: PRIMARY,
    primary: PRIMARY,
    outline: OUTLINE,
    ghost: 'text-muted-foreground hover:bg-muted font-medium',
    ok: 'bg-success/15 text-success hover:bg-success/25 font-medium',
    deny: 'bg-destructive/15 text-destructive hover:bg-destructive/25 font-medium',
  }[variant];
  return (
    <button className={cn(base, sz, v)} onClick={onClick} disabled={disabled || busy} title={title} aria-busy={busy || undefined}>
      {busy ? <span className="record-dot record-dot--live" aria-hidden /> : arrow && <span aria-hidden>›</span>}
      {children}
    </button>
  );
}

export function Badge({
  children, tone = 'muted', live,
}: {
  children: ReactNode; tone?: 'muted' | 'brand' | 'success' | 'warning' | 'info' | 'destructive' | 'model';
  /** "running/live" state — adds a .live-dot pulse (only meaningful together with tone="success"). */
  live?: boolean;
}) {
  // GNL recipe: success=Neon Green tint ("running/live" — a pulse dot is added while live=true),
  // brand=Fluo Lime tint ("active" — rare/high-impact), muted=Ink+border+muted text ("draft"/neutral),
  // destructive=soft red tint ("error"), model=Ink+border+MONO text (data badges like a model
  // name). warning/info keep their original tones outside brand scope (T1 decision: deliberate).
  const t = {
    muted: 'border border-border bg-muted/40 text-muted-foreground',
    brand: 'bg-brand/15 text-brand',
    success: 'bg-success/15 text-success',
    warning: 'bg-warning/15 text-warning',
    info: 'bg-info/15 text-info',
    destructive: 'bg-destructive/15 text-destructive',
    model: 'border border-border bg-transparent text-foreground',
  }[tone];
  // Tag-strip language: mono + squared — badge contents (status/model/tool name) are data.
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide', t)}>
      {live && <span className="live-dot" aria-hidden />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  // Pill-shaped status chip. Running is INFO (cool blue) + a live pulse, deliberately distinct from
  // Completed (success green) — before, both were green and read as the same state. Needs-approval /
  // suspended = warning (amber); failed/error/cancelled = destructive (red). Unknown → neutral (never
  // fail-open to green). Squared mono `Badge` above is kept for DATA tags (model/tool names).
  const s = status.toLowerCase();
  const info = 'bg-info/15 text-info';
  const cls =
    s === 'running' || s === 'in_progress' ? info
    : s === 'suspended' || s === 'needs approval' || s === 'needs_approval' || s === 'pending' ? 'bg-warning/15 text-warning'
    : s === 'failed' || s === 'error' || s === 'cancelled' ? 'bg-destructive/15 text-destructive'
    : s === 'completed' || s === 'done' || s === 'ok' || s === 'success' ? 'bg-success/15 text-success'
    : 'border border-border bg-muted/40 text-muted-foreground';
  const live = s === 'running' || s === 'in_progress';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize', cls)}>
      {live && <span className="live-dot" aria-hidden />}
      {status}
    </span>
  );
}

/** Stat-card summary strip (the Inspector's signature at-a-glance row) — reused across data pages so
    they share one visual language. Each item is a labeled card with a big mono value. Below md it's a
    horizontally scrollable single row (cards keep a minimum width instead of being dropped from the
    DOM); at md+ it becomes the equal-width grid. Pass only REAL, already-fetched values (no
    fabricated trend deltas). */
export function StatStrip({ items }: { items: { label: string; value: string }[] }) {
  if (!items.length) return null;
  // gridTemplateColumns only takes effect once `md:grid` switches display to grid — under the
  // mobile flex row it's inert (grid-* properties are no-ops outside display:grid).
  return (
    <div className="flex shrink-0 gap-3 overflow-x-auto border-b border-border p-3 md:grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((c) => (
        <div key={c.label} className="min-w-[132px] shrink-0 rounded-lg border border-border bg-card px-4 py-3 md:min-w-0">
          <div className="truncate text-xs text-muted-foreground">{c.label}</div>
          {/* VIS-04: title exposes the full value on hover when truncate clips it (this is the number
              itself, not a label — losing it silently would mislead a budget/cost read); text-xl at the
              md breakpoint (narrowest width StatStrip renders at, before lg) leaves more room per digit. */}
          <div title={c.value} className="mt-1.5 truncate font-mono text-xl font-bold leading-none text-foreground lg:text-2xl">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Page-level header: the ONE place a view's <h1>, one-sentence description, and primary/secondary
 * actions live. Use it at the top of a view's canvas in place of ad hoc microlabel-as-heading markup
 * (or no heading at all) — `actions` is the single slot for a view's primary action, not one of
 * several scattered spots. `meta` covers the existing "microlabel + count" pattern (e.g. a "12 runs"
 * counter/badge next to the title) without duplicating that count into `description`. Title and
 * description stack above actions on narrow viewports so actions never overflow the row.
 * NOTE: this is a new primitive, not yet adopted by existing views (that migration is a separate pass).
 */
export function PageHeader({ title, description, actions, meta }: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions (primary + any secondary) — the single place a view's primary action lives. */
  actions?: ReactNode;
  /** Optional counter/badge next to the title (the "microlabel + count" pattern). */
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3 md:flex-row md:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-bold tracking-tight text-foreground">{title}</h1>
          {meta}
        </div>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 md:ml-auto">{actions}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation('common');
  // record-dot (index.css): the same live-pulse pattern is shared with the playback indicator in
  // Inspector — reuses the existing lime accent language instead of inventing a new indicator.
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
      <span className="record-dot record-dot--live" aria-hidden />
      {label ?? t('loading')}
    </div>
  );
}

/**
 * Route-level loading placeholder for the top-level Suspense fallback (App.tsx) — shown while a
 * lazy view chunk downloads, in place of what used to be a bare `<Spinner />` (a single line of
 * text top-left while the rest of the canvas went blank, a visible layout jump). Approximates the
 * shape most views now share since PageHeader landed: a header strip, then a few content rows.
 * Deliberately coarse — an approximation to cut layout shift, not a pixel-accurate mimic of any
 * one view's StatStrip/table/list, which would look "wrong" more often than it looked right.
 * Decorative: the bars are aria-hidden, and `role="status"` + the sr-only text carry the actual
 * "loading" announcement to screen readers instead (Spinner's visible label, preserved this way).
 */
export function ViewSkeleton() {
  const { t } = useTranslation('common');
  return (
    <div role="status" className="flex h-full flex-col">
      <span className="sr-only">{t('loading')}</span>
      <div aria-hidden className="flex flex-col gap-3 border-b border-border px-4 py-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="skeleton-pulse h-4 w-40 rounded-sm bg-muted" />
          <div className="skeleton-pulse h-3 w-64 rounded-sm bg-muted/70" />
        </div>
      </div>
      <div aria-hidden className="flex flex-col gap-3 p-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skeleton-pulse h-8 w-full shrink-0 rounded-sm bg-muted" />
        ))}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-6 text-sm text-muted-foreground">{children}</div>;
}

/**
 * Full-canvas empty state: icon + title + one-sentence description + optional action — for views
 * whose ENTIRE canvas is empty (Scheduler/Tools/Jobs/Audit and similar), replacing what used to be
 * a single bare line of text (skeleton feel) with a deliberate "nothing here yet, here's why /
 * what to do" card. `Empty` above stays for small INLINE notes inside an already-populated view
 * (e.g. "no messages this step") — that plain one-liner is still the right weight there.
 * (Formerly `views/Placeholder.tsx`'s unused `Placeholder({title,note})` — repurposed here since
 * this is a shared UI primitive, not a route view; the old file was deleted.)
 */
export function EmptyState({
  icon: Icon, title, description, action,
}: {
  // `size`/`className` loose enough to accept lucide-react icon components directly (their real
  // prop type is broader — string|number size, SVG attrs, etc. — this is just the subset EmptyState uses).
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 p-8 text-center">
      {Icon && (
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-muted/30 text-muted-foreground">
          <Icon size={20} />
        </div>
      )}
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  // STATE-10: errMessage() strips the technical "ApiError:"/"Error:" prefix `String(error)` used to
  // leak (see api.ts's errMessage JSDoc — "Use this in all views' toast/error display"). The box is
  // already role="alert" with a red border/text, so a redundant "Error:" label was dropped (D4-11) —
  // the styling alone communicates the severity.
  return <div role="alert" className="m-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{errMessage(error)}</div>;
}

// Collapsible JSON node: object/array → <details> (open below depth 2), primitives get color tinting.
function JsonNode({ k, v, depth }: { k?: string; v: unknown; depth: number }) {
  const label = k !== undefined && (
    <>
      <span className="text-info/90">{k}</span>
      <span>: </span>
    </>
  );
  if (v !== null && typeof v === 'object') {
    const isArr = Array.isArray(v);
    const entries = isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as object);
    if (entries.length === 0) return <div>{label}{isArr ? '[]' : '{}'}</div>;
    return (
      <details open={depth < 2}>
        <summary className="cursor-pointer select-none hover:text-foreground">
          {label}
          <span className="text-brand/80">{isArr ? `[${entries.length}]` : `{${entries.length}}`}</span>
        </summary>
        <div className="ml-1.5 border-l border-border/60 pl-2.5">
          {entries.map(([ck, cv]) => <JsonNode key={ck} k={ck} v={cv} depth={depth + 1} />)}
        </div>
      </details>
    );
  }
  const prim = typeof v === 'string' ? `"${v.length > 240 ? v.slice(0, 240) + '…' : v}"` : String(v);
  const tone = typeof v === 'string' ? 'text-success/90' : typeof v === 'number' ? 'text-warning' : '';
  return (
    <div className="break-words">
      {label}
      <span className={tone}>{prim}</span>
    </div>
  );
}

/** JSON viewer: objects render as a collapsible tree; plain strings use the old <pre> behavior (max truncation). */
export function JsonBlock({ value, max = 1200 }: { value: unknown; max?: number }) {
  const { t } = useTranslation('common');
  // Bug-investigation fix #6: don't show the literal "null"/"undefined" for null/undefined — show "No data" instead.
  if (value === null || value === undefined) return <Empty>{t('noData')}</Empty>;
  if (typeof value === 'string') {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
        {value.length > max ? value.slice(0, max) + ' …' : value}
      </pre>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
      <JsonNode v={value} depth={0} />
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string }[]; active: T; onChange: (t: T) => void }) {
  // overflow-x-auto + shrink-0 buttons: on a narrow (mobile) viewport a long tab strip scrolls
  // horizontally IN PLACE instead of wrapping/overflowing the page (common mobile tab-strip pattern).
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // A11Y-06: real ARIA APG tabs pattern — role="tablist" on the wrapper, role="tab" + aria-selected
  // on each button, roving tabindex (only the active tab is Tab-key reachable; ArrowLeft/Right both
  // move selection AND move focus, per the APG "automatic activation" tabs pattern). This is the
  // correct semantics for a real tab strip (screen readers announce "tab, selected, N of M"), unlike
  // a toggle-button group (aria-pressed). Call-site tests were updated to query by role="tab" instead
  // of role="button" for these tab strips (agents-tabs.test.tsx, network-view.test.tsx).
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    if (next === -1) return;
    e.preventDefault();
    onChange(tabs[next].id);
    btnRefs.current[next]?.focus();
  };
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => { btnRefs.current[i] = el; }}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
          className={cn(
            '-mb-px shrink-0 border-b-2 px-3 py-1.5 text-sm transition-colors',
            active === t.id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

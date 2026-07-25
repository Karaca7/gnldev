import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Activity, Boxes, Workflow, Network, Plug, Inbox, ScrollText, Building2, Shield,
  FlaskConical, Gauge, Wrench, Moon, Sun, Languages, MessageSquare, BookOpen, ListChecks, Library, LogOut, Users as UsersIcon,
  AlertTriangle, Database, Clock, Menu, Search,
} from 'lucide-react';
import { useCapabilities, useMe, api, ApiError, shouldForceReauth, type Capabilities } from './api';
import { Spinner, Btn, ErrorBox, cn } from './components';
import { CommandPalette, type CommandItem } from './ui';
import { getToken, setToken, clearToken } from './auth';
import { PageTransition } from './motion';
import i18n, { getStoredLang, LANG_STORAGE_KEY, type SupportedLang } from './i18n';

/** Brand: the whole "›GNL" mark inside ONE Ink card — a lime "›" caret + the Paper "GNL" wordmark,
    bordered + rounded, no gap or separate emblem that could drift apart. Fixed and identical
    everywhere (Studio + portal + site). `size="lg"` is the larger Login/splash size (card only);
    the default `sm` is the sidebar / compact top bar and appends a soft "studio" product label.
    The "›" is decorative → aria-hidden; "GNL" is readable text. */
function BrandMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const big = size === 'lg';
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded-md border border-border bg-background font-extrabold leading-none tracking-tight',
          big ? 'px-2.5 py-2 text-lg' : 'px-2 py-1.5 text-sm',
        )}
      >
        <span aria-hidden className="mr-0.5 text-brand">›</span>
        <span className="text-foreground">GNL</span>
      </span>
      {!big && <span className="text-sm font-medium text-muted-foreground">studio</span>}
    </div>
  );
}

// Code-split: heavy views (xyflow/recharts) get their own chunk → smaller initial bundle.
const named = <K extends string>(p: Promise<Record<K, ComponentType>>, k: K) => p.then((m) => ({ default: m[k] }));
const Inspector = lazy(() => named(import('./views/Inspector'), 'Inspector'));
const Observability = lazy(() => named(import('./views/Observability'), 'Observability'));
const Playground = lazy(() => named(import('./views/Playground'), 'Playground'));
const Agents = lazy(() => named(import('./views/Agents'), 'Agents'));
const Tools = lazy(() => named(import('./views/Tools'), 'Tools'));
const Workflows = lazy(() => named(import('./views/Workflows'), 'Workflows'));
const Evals = lazy(() => named(import('./views/Evals'), 'Evals'));
const Jobs = lazy(() => named(import('./views/Jobs'), 'Jobs'));
const Cache = lazy(() => named(import('./views/Cache'), 'Cache'));
const Scheduler = lazy(() => named(import('./views/Scheduler'), 'Scheduler'));
const Knowledge = lazy(() => named(import('./views/Knowledge'), 'Knowledge'));
const Networks = lazy(() => named(import('./views/Networks'), 'Networks'));
const Mcp = lazy(() => named(import('./views/Mcp'), 'Mcp'));
const Approvals = lazy(() => named(import('./views/Approvals'), 'Approvals'));
const Audit = lazy(() => named(import('./views/Audit'), 'Audit'));
const Organizations = lazy(() => named(import('./views/Organizations'), 'Organizations'));
const Users = lazy(() => named(import('./views/Users'), 'Users'));
const Policy = lazy(() => named(import('./views/Policy'), 'Policy'));

// `labelKey` → a key into i18n/locales/{en,tr}/nav.json (not literal text); resolved via
// `t(labelKey)` at render time (see AppShell). This way nav returns the correct language on a
// language switch without a special-case re-render (i18next already triggers a re-render on change).
//
// `group` — three logical sections rendered with a divider + microlabel header (see NAV_GROUPS):
//   runs        = watching/interacting with live agent execution (Inspector/Observability/Playground)
//   build       = everything that defines/executes the platform's building blocks (agents, tools,
//                 workflows + their supporting infra: jobs/cache/scheduler/knowledge/evals/networks/mcp)
//   governance  = access control + compliance surfaces (the pre-existing "Governance" grouping below,
//                 now made visible in the UI, not just in this comment)
type NavGroupKey = 'runs' | 'build' | 'governance';
type NavItem = { to: string; labelKey: string; icon: any; cap?: keyof Capabilities; group: NavGroupKey };
const NAV: NavItem[] = [
  { to: '/inspector', labelKey: 'inspector', icon: Activity, group: 'runs' },
  { to: '/observability', labelKey: 'observability', icon: Gauge, group: 'runs' },
  { to: '/playground', labelKey: 'playground', icon: MessageSquare, cap: 'playground', group: 'runs' },
  { to: '/agents', labelKey: 'agents', icon: Boxes, cap: 'playground', group: 'build' },
  { to: '/tools', labelKey: 'tools', icon: Wrench, cap: 'tools', group: 'build' },
  { to: '/workflows', labelKey: 'workflows', icon: Workflow, cap: 'workflows', group: 'build' },
  { to: '/jobs', labelKey: 'jobs', icon: ListChecks, cap: 'queue', group: 'build' },
  { to: '/cache', labelKey: 'cache', icon: Database, cap: 'cache', group: 'build' },
  { to: '/scheduler', labelKey: 'scheduler', icon: Clock, cap: 'scheduler', group: 'build' },
  { to: '/knowledge', labelKey: 'knowledge', icon: Library, cap: 'knowledge', group: 'build' },
  { to: '/evals', labelKey: 'evals', icon: FlaskConical, group: 'build' },
  { to: '/networks', labelKey: 'networks', icon: Network, cap: 'a2a', group: 'build' },
  { to: '/mcp', labelKey: 'mcp', icon: Plug, cap: 'mcp', group: 'build' },
  // Governance: approvals inbox / audit log / organizations (enabled via server capability flags).
  { to: '/approvals', labelKey: 'approvals', icon: Inbox, cap: 'approvals', group: 'governance' },
  { to: '/audit', labelKey: 'audit', icon: ScrollText, cap: 'audit', group: 'governance' },
  { to: '/organizations', labelKey: 'organizations', icon: Building2, cap: 'organizations', group: 'governance' },
  { to: '/users', labelKey: 'users', icon: UsersIcon, cap: 'userManage', group: 'governance' },
  { to: '/policy', labelKey: 'policy', icon: Shield, cap: 'policy', group: 'governance' },
];
const NAV_GROUPS: { key: NavGroupKey; titleKey: string }[] = [
  { key: 'runs', titleKey: 'groupRuns' },
  { key: 'build', titleKey: 'groupBuild' },
  { key: 'governance', titleKey: 'groupGovernance' },
];

// Nav-like rows (theme/logout/Swagger) share the same alignment+weight as active nav items (DRY).
const NAV_ITEM_CLASS =
  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:text-foreground';

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem('gnl-theme') !== 'light');
  useEffect(() => {
    document.body.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('gnl-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

/** Language switcher: same pattern as the theme toggle ('gnl-theme' → 'gnl-lang' localStorage key,
    see src/i18n/index.ts LANG_STORAGE_KEY). i18next.changeLanguage automatically re-renders all
    components consuming useTranslation(); <html lang> is also kept in sync here (a11y/SEO). */
function useLanguage() {
  const { i18n } = useTranslation();
  const [lang, setLang] = useState<SupportedLang>(() => getStoredLang());
  useEffect(() => {
    document.documentElement.lang = lang;
    localStorage.setItem(LANG_STORAGE_KEY, lang);
    if (i18n.language !== lang) void i18n.changeLanguage(lang);
  }, [lang, i18n]);
  return { lang, toggle: () => setLang((l) => (l === 'en' ? 'tr' : 'en')) };
}

/** Sidebar footer identity chip: the signed-in principal (real GET /me) + workspace/plan. NOT
    decorative — id/org/operator come from the server; `plan` from the license capabilities. Hidden
    when auth is off (no principal id) so it never shows an empty/fake workspace. */
function WorkspaceChip({ plan }: { plan?: string }) {
  const me = useMe();
  const id = me.data?.id ?? null;
  if (!id) return null;
  const org = me.data?.orgId ?? null;
  const operator = me.data?.operator;
  const initials = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const name = org ?? (operator ? 'platform' : id);
  const sub = operator ? 'operator' : plan ? `${plan} plan` : 'workspace';
  return (
    <div className="m-2 mt-1 flex items-center gap-2.5 rounded-md border border-border bg-muted/30 px-2.5 py-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand text-xs font-bold text-brand-foreground">
        {initials}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{sub}</span>
      </span>
    </div>
  );
}

/**
 * Sidebar contents (brand + grouped nav + swagger link + kbd hint + lang/theme/logout) — shared
 * between the desktop `<aside>` (always visible ≥768px) and the mobile slide-in drawer (<768px,
 * see MobileNavDrawer). `onNavigate` is only passed by the mobile drawer, to close itself on any
 * nav click; the desktop sidebar has no such need (nothing to close) so it's omitted there.
 */
function SidebarContent({
  visible, t, tc, lang, toggleLang, dark, toggle, onLogout, onNavigate, plan,
}: {
  visible: NavItem[];
  t: (key: string) => string;
  tc: (key: string) => string;
  lang: SupportedLang;
  toggleLang: () => void;
  dark: boolean;
  toggle: () => void;
  onLogout?: () => void;
  onNavigate?: () => void;
  plan?: string;
}) {
  return (
    <>
      <div className="px-4 py-3.5">
        <BrandMark />
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {NAV_GROUPS.map((g, gi) => {
          const items = visible.filter((n) => n.group === g.key);
          if (items.length === 0) return null; // capability-hidden group → the header itself stays hidden too
          return (
            <div key={g.key} className={cn(gi > 0 && 'mt-3 border-t border-border/60 pt-3')}>
              {/* A11Y-11: full-opacity --muted-foreground (AA-safe per index.css), not /70 — at 10px this
                  text doesn't qualify for the "large text" 3:1 exception, so hierarchy comes from the
                  .microlabel typography (mono + uppercase + letter-spacing) alone, not from fading it out. */}
              <div className="microlabel px-3 pb-1 text-muted-foreground">{t(g.titleKey)}</div>
              {items.map(({ to, labelKey, icon: Icon }) => {
                const label = t(labelKey);
                return (
                  <NavLink
                    key={to}
                    to={to}
                    title={label}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                        // Active nav: lime tint background + lime text/icon (icon uses currentColor to follow the text).
                        isActive
                          ? 'bg-brand/15 text-brand'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:text-foreground',
                      )
                    }
                  >
                    <Icon size={15} className="shrink-0" /> <span>{label}</span>
                  </NavLink>
                );
              })}
            </div>
          );
        })}
        {/* Swagger: a non-SPA server route (relative → resolved under the mount via <base href>). */}
        <a href="swagger" title="API (Swagger)" className={cn(NAV_ITEM_CLASS, 'mt-3 border-t border-border/60 pt-3')} onClick={onNavigate}>
          <BookOpen size={15} className="shrink-0" /> <span>API (Swagger)</span>
        </a>
      </nav>
      <div className="hidden px-4 pb-1 sm:block">
        <kbd className="microlabel rounded border border-brand/25 bg-muted/50 px-1.5 py-0.5 text-brand">Ctrl K</kbd>
      </div>
      {/* Language switcher: EN default/TR secondary, in the same row group as the theme toggle (see useLanguage). */}
      <button type="button" onClick={toggleLang} title="Language / Dil" className={cn(NAV_ITEM_CLASS, 'm-2 mb-0')}>
        <Languages size={15} className="shrink-0" /> <span>{lang === 'en' ? 'EN' : 'TR'}</span>
      </button>
      <button type="button" onClick={toggle} title={tc('theme')} className={cn(NAV_ITEM_CLASS, 'm-2 mb-0')}>
        {dark ? <Sun size={15} className="shrink-0" /> : <Moon size={15} className="shrink-0" />} <span>{dark ? tc('lightTheme') : tc('darkTheme')}</span>
      </button>
      {/* Logout: only visible while auth is on (clears the token). */}
      {onLogout && (
        <button type="button" onClick={onLogout} title={tc('logout')} className={cn(NAV_ITEM_CLASS, 'm-2 mb-0')}>
          <LogOut size={15} className="shrink-0" /> <span>{tc('logout')}</span>
        </button>
      )}
      {/* Footer identity chip — real principal (GET /me) + license plan. */}
      <WorkspaceChip plan={plan} />
    </>
  );
}

function AppShell({ onLogout }: { onLogout?: () => void }) {
  const caps = useCapabilities();
  const { dark, toggle } = useTheme();
  const { lang, toggle: toggleLang } = useLanguage();
  const { t } = useTranslation('nav');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const visible = NAV.filter((n) =>
    n.to === '/evals' ? caps.data?.scorers || caps.data?.datasets : !n.cap || caps.data?.[n.cap],
  );

  // Ctrl/Cmd+K palette: views + theme/session actions in a single search box.
  const commands: CommandItem[] = [
    ...visible.map((n) => ({ id: n.to, label: t(n.labelKey), hint: tc('viewHint'), onSelect: () => navigate(n.to) })),
    { id: 'theme', label: dark ? tc('switchToLightTheme') : tc('switchToDarkTheme'), hint: tc('themeHint'), onSelect: toggle },
    ...(onLogout ? [{ id: 'logout', label: tc('logoutAction'), hint: tc('sessionHint'), onSelect: onLogout }] : []),
  ];

  // Close the mobile drawer automatically on a route change (e.g. via Ctrl/Cmd+K or a browser
  // back/forward) so it doesn't stay stuck open over the newly-navigated view.
  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* A11Y-08 (WCAG 2.4.1 Bypass Blocks): first focusable element in the shell — a keyboard user
          can jump straight to <main> instead of tabbing through the full sidebar (~19 nav items +
          Swagger/lang/theme/logout) on every single page load. Visually hidden until focused. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-popover focus:px-3 focus:py-2"
      >
        {tc('skipToContent')}
      </a>
      <CommandPalette items={commands} />

      {/* Mobile top bar (<768px): hamburger opens the slide-in drawer below; the full sidebar
          (icon strip) doesn't fit a phone screen and used to squeeze every other panel offscreen —
          see MobileNavDrawer / the `hidden md:flex` desktop <aside> further down. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-deep px-3 py-2.5 md:hidden">
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          aria-label={tc('openNavigation')}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <Menu size={20} />
        </button>
        <BrandMark />
      </header>

      {/* Mobile slide-in drawer: same SidebarContent as the desktop aside, in a Radix Dialog
          (focus trap + Escape-to-close + overlay-click-to-close come for free, same primitive
          already used by Dialog/CommandPalette in ui.tsx). */}
      <DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px] md:hidden" />
          <DialogPrimitive.Content
            className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[80vw] flex-col border-r border-border bg-surface-deep outline-none md:hidden"
          >
            <DialogPrimitive.Title className="sr-only">{tc('navigationLabel')}</DialogPrimitive.Title>
            <SidebarContent
              visible={visible} t={t} tc={tc} lang={lang} toggleLang={toggleLang} dark={dark} toggle={toggle}
              onLogout={onLogout} onNavigate={() => setMobileNavOpen(false)} plan={caps.data?.plan}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Desktop sidebar (≥768px) — surface staircase: the sidebar is the deepest layer
          (--surface-deep/#0c0c0e) — main content sits one step above Ink. */}
      <aside className="hidden md:flex md:w-56 md:flex-col md:border-r md:border-border md:bg-surface-deep">
        <SidebarContent visible={visible} t={t} tc={tc} lang={lang} toggleLang={toggleLang} dark={dark} toggle={toggle} onLogout={onLogout} plan={caps.data?.plan} />
      </aside>

      <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Desktop top bar (≥768px): breadcrumb · palette-search · New run. Mobile has its own bar above.
            The search box opens the SAME Ctrl/Cmd+K command palette (synthetic keydown) — no separate
            search implementation, it's the existing palette. "New run" jumps to the Playground. */}
        <header className="hidden shrink-0 items-center gap-4 border-b border-border bg-surface-1 px-5 py-2.5 md:flex">
          <nav className="flex items-center gap-1.5 text-sm" aria-label="breadcrumb">
            <span className="text-muted-foreground">Studio</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="font-medium text-foreground">
              {(() => { const a = NAV.find((n) => location.pathname.startsWith(n.to)); return a ? t(a.labelKey) : ''; })()}
            </span>
          </nav>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}
            className="ml-auto flex w-full max-w-sm items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-brand/40 hover:text-foreground"
          >
            <Search size={14} className="shrink-0" />
            <span className="flex-1 text-left">{tc('searchStudio')}</span>
            <kbd className="microlabel rounded border border-border px-1.5 py-0.5">Ctrl K</kbd>
          </button>
          {caps.data?.playground && (
            <Btn variant="primary" arrow onClick={() => navigate('/playground')}>{tc('newRun')}</Btn>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
        <Suspense fallback={<Spinner />}>
          {/* Signature motion: view transition (D-motion). BrandMark/tokens untouched — only
              this render region is wrapped. `routeKey=pathname` triggers a subtle upward-sliding
              fade with a terminal-prompt feel on every nav click; under prefers-reduced-motion,
              PageTransition passes through plainly (see src/motion.tsx). */}
          <PageTransition routeKey={location.pathname}>
            <Routes>
              <Route path="/" element={<Navigate to="/inspector" replace />} />
              <Route path="/inspector" element={<Inspector />} />
              <Route path="/observability" element={<Observability />} />
              <Route path="/playground" element={<Playground />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/tools" element={<Tools />} />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/evals" element={<Evals />} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/cache" element={<Cache />} />
              <Route path="/scheduler" element={<Scheduler />} />
              <Route path="/knowledge" element={<Knowledge />} />
              <Route path="/networks" element={<Networks />} />
              <Route path="/mcp" element={<Mcp />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/organizations" element={<Organizations />} />
              <Route path="/users" element={<Users />} />
              <Route path="/policy" element={<Policy />} />
              <Route path="*" element={<Navigate to="/inspector" replace />} />
            </Routes>
          </PageTransition>
        </Suspense>
        </div>
      </main>
    </div>
  );
}

/** Simple token login screen (while server opt-in auth is on). Validates the token against a gated endpoint, writes it to localStorage. */
function Login({ sso, onAuthed }: { sso?: boolean; onAuthed: () => void }) {
  const { t } = useTranslation('common');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const tok = value.trim();
    if (!tok || busy) return;
    setBusy(true);
    setError(null);
    setToken(tok);
    try {
      await api.runs(); // gated read → validates the token
      onAuthed();
    } catch (err) {
      clearToken();
      setError(
        err instanceof ApiError && (err.status === 401 || err.status === 403)
          ? t('invalidToken')
          : t('connectionFailed', { error: String(err) }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <form onSubmit={submit} className="w-80 rounded-lg border border-border bg-card p-7 shadow-sm">
        <div className="mb-6">
          <BrandMark size="lg" />
        </div>
        <h1 className="mb-1 text-lg font-bold tracking-tight text-foreground">{t('signInTitle')}</h1>
        <p className="mb-5 text-xs text-muted-foreground">{t('signInSubtitle')}</p>
        <label htmlFor="gnl-token" className="mb-1 block text-xs font-medium text-muted-foreground">{t('accessTokenLabel')}</label>
        <input
          id="gnl-token"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Bearer token"
          className="mb-3 w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground outline-none"
        />
        {error && <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
        <Btn disabled={busy || !value.trim()}>{busy ? t('verifying') : t('signIn')}</Btn>
        {sso && (
          <button
            type="button"
            disabled
            title={t('ssoComingSoon')}
            className="ml-2 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground opacity-60"
          >
            {t('signInWithSso')}
          </button>
        )}
      </form>
    </div>
  );
}

/**
 * F6.6 — ErrorBoundary: if a view's render throws, don't let the ENTIRE SPA go white-screen;
 * show an error card + "reload" instead. Only catches render/lifecycle errors (React boundary);
 * async/event errors flow through react-query. Tested under jsdom in `test/`.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    // Log to console (no external log service) — the card message is for the user, the detail for the developer.
    console.error('[studio-ui] render error:', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    // Class component: can't use the useTranslation hook → call t() directly from the global i18n instance.
    const t = (key: string) => i18n.t(key, { ns: 'common' });
    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <div className="w-96 max-w-full rounded-lg border border-destructive/30 bg-card p-7 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-destructive">
            <AlertTriangle size={18} className="shrink-0" />
            <h1 className="text-base font-bold tracking-tight">{t('somethingWentWrong')}</h1>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            {t('unexpectedErrorMessage')}
          </p>
          <pre className="mb-4 max-h-32 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <Btn onClick={() => window.location.reload()}>{t('reload')}</Btn>
        </div>
      </div>
    );
  }
}

/**
 * Bug-investigation fix #1 (CRITICAL): on caps.isError, authRequired must not silently fall
 * back to false and skip Login to show a broken AppShell — use a separate "couldn't connect" screen instead.
 */
function CapsError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="w-96 max-w-full rounded-lg border border-destructive/30 bg-card p-7 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-destructive">
          <AlertTriangle size={18} className="shrink-0" />
          <h1 className="text-base font-bold tracking-tight">{t('unableToReachServer')}</h1>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {t('capsErrorMessage')}
        </p>
        <ErrorBox error={error} />
        <div className="mt-4">
          <Btn onClick={onRetry}>{t('retry')}</Btn>
        </div>
      </div>
    </div>
  );
}

/** Auth gate: Login if server auth is on (authRequired) and there's no token; otherwise the app. */
export default function App() {
  const caps = useCapabilities();
  const qc = useQueryClient();
  const [token, setTok] = useState<string | null>(() => getToken());
  // Bug-investigation fix #1: authRequired is "unknown" (undefined) until caps data arrives —
  // it's derived ONLY from a successful response, it does NOT fail-open to false on isError.
  const authRequired: boolean | undefined = caps.data ? !!caps.data.authRequired : undefined;

  // F6.2 — Mid-session token revocation/expiry → if any query/mutation returns 401/403,
  // fall back to a clean login (clear token + flush cache). shouldForceReauth already won't
  // fire without a token → no 401 loop on the Login screen. (Hooks unconditional: BEFORE early returns.)
  useEffect(() => {
    const forceReauthIf = (err: unknown) => {
      if (shouldForceReauth({ err, authRequired: !!authRequired, hasToken: !!getToken() })) {
        clearToken();
        setTok(null);
        qc.clear();
      }
    };
    const unsubQ = qc.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.state.status === 'error') {
        forceReauthIf(event.query.state.error);
      }
    });
    const unsubM = qc.getMutationCache().subscribe((event) => {
      if (event.mutation?.state.status === 'error') forceReauthIf(event.mutation.state.error);
    });
    return () => { unsubQ(); unsubM(); };
  }, [qc, authRequired]);

  if (caps.isLoading) return <Spinner />;
  // Bug-investigation fix #1 (CRITICAL): don't fall through to AppShell on isError — don't skip
  // Login and show a broken UI. The user can retry fetching capabilities via "Retry".
  if (caps.isError) return <CapsError error={caps.error} onRetry={() => caps.refetch()} />;

  const onLogout = authRequired
    ? () => { clearToken(); setTok(null); qc.clear(); }
    : undefined;

  return (
    <ErrorBoundary>
      {authRequired && !token
        ? <Login sso={!!caps.data?.sso} onAuthed={() => { setTok(getToken()); qc.invalidateQueries(); }} />
        : <AppShell onLogout={onLogout} />}
    </ErrorBoundary>
  );
}

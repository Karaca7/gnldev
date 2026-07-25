import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Badge } from '../components';
import { ConfirmDialog } from '../ui';

// Clear button: text longer than this requires confirmation before wiping (short drafts clear
// instantly, no friction). Below or at this length, clearing is still instant but reversible.
const CLEAR_CONFIRM_THRESHOLD = 200;
// Window during which a destructive clear can be undone (ms).
const UNDO_WINDOW_MS = 10_000;

// ── The consistent skeleton of a good agent system prompt: Role → Task → Context → Rules →
//    Tool usage → Output format → Constraints → Tone → (optional Examples). Templates/snippets
//    offer this structure and agentic best practices (don't guess → call the tool, grounding,
//    loop prevention, authorization/privacy) as ready-made blocks. RULE snippets are SYNCED with
//    SECTIONs: each snippet belongs to a section (SnippetGroup.section) and, when added, is placed
//    under that section (auto-created if the section doesn't exist yet) → the prompt stays
//    self-structuring.
//
//    Template/section/rule TEXTS are now kept as i18n KEYs (since a hook can't be called at
//    module scope); the actual text is resolved via `buildPromptTemplates`/`buildPromptSections`/
//    `buildSnippetGroups` — given the `t` from `useTranslation('promptEditor')` inside the
//    component (see locales/{en,tr}/promptEditor.json → templates/sections/snippets). In tests,
//    without the hook, it can be resolved the same way with `i18n.getFixedT(lng, 'promptEditor')`
//    (see test/prompt-editor.test.ts).

export interface PromptTemplate { label: string; body: string }

const TEMPLATE_KEYS = ['rag', 'toolAgent', 'extractor', 'support'] as const;

/** Resolves PROMPT_TEMPLATES from i18n keys (label/body → templates.<key>.label/body). */
export function buildPromptTemplates(t: TFunction): PromptTemplate[] {
  return TEMPLATE_KEYS.map((key) => ({
    label: t(`templates.${key}.label`),
    body: t(`templates.${key}.body`),
  }));
}

// Section headings (bare — a `# ` prefix is added when inserted). RULE groups match these keys.
const SECTION_KEYS = ['role', 'task', 'context', 'rules', 'toolUsage', 'outputFormat', 'constraints', 'tone', 'examples'] as const;

/** Resolves PROMPT_SECTIONS from i18n keys (sections.<key>). */
export function buildPromptSections(t: TFunction): string[] {
  return SECTION_KEYS.map((key) => t(`sections.${key}`));
}

// Each snippet group belongs to one SECTION (sectionKey) → when added, it's placed under that
// section. This way "+ Section" and "+ Rule" stay in sync (same taxonomy, rules collect under the right heading).
export interface SnippetGroup { section: string; items: string[] }

const SNIPPET_GROUP_KEYS = ['rules', 'toolUsage', 'outputFormat', 'constraints', 'tone'] as const;

/** Resolves SNIPPET_GROUPS from i18n keys; the section name comes from the same taxonomy as SECTION_KEYS. */
export function buildSnippetGroups(t: TFunction): SnippetGroup[] {
  return SNIPPET_GROUP_KEYS.map((key) => ({
    section: t(`sections.${key}`),
    items: t(`snippets.${key}`, { returnObjects: true }) as string[],
  }));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sectionHeadRe = (section: string) => new RegExp(`^#\\s*${escapeRegExp(section)}\\s*$`, 'i');

/** Adds the section heading (if missing) — idempotent: leaves the text unchanged if it already exists. */
export function addSection(text: string, section: string): string {
  if (sectionHeadRe(section).test(text) || text.split('\n').some((l) => sectionHeadRe(section).test(l))) return text;
  const base = text.trimEnd();
  return (base ? base + '\n\n' : '') + `# ${section}`;
}

/** Adds the rule under the section it BELONGS TO; creates the section at the end if missing. Synced with "+ Section". */
export function addRuleToSection(text: string, section: string, rule: string): string {
  const line = rule.startsWith('- ') ? rule : `- ${rule}`;
  const lines = text.split('\n');
  const headIdx = lines.findIndex((l) => sectionHeadRe(section).test(l));
  if (headIdx === -1) {
    const base = text.trimEnd();
    return (base ? base + '\n\n' : '') + `# ${section}\n${line}`;
  }
  // End of the section: up to the next `# ` heading; insert before any trailing blank lines.
  let end = headIdx + 1;
  while (end < lines.length && !/^#\s+/.test(lines[end])) end++;
  let at = end;
  while (at - 1 > headIdx && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

/** `labelKey`: `lint.<key>` within the 'promptEditor' namespace — resolved with `t()` in the component. */
export interface LintItem { key: string; labelKey: string; ok: boolean }

/** Good-prompt audit (NOT blocking — advisory): looks at a heading OR a keyword signal.
    Pure function — produces no message TEXT, only returns `labelKey` (the caller translates it
    with `t(labelKey)`). Detection is MULTILINGUAL: the developer may write the prompt in Turkish
    OR English, so the keyword lists are kept in both languages (only the produced MESSAGE is
    translated, detection itself is language-independent). Since `\b` is problematic with Turkish
    characters, keywords are matched by substring instead. */
export function lintPrompt(text: string): LintItem[] {
  const t = text.toLowerCase();
  const inc = (...ks: string[]) => ks.some((k) => t.includes(k));
  const head = (re: RegExp) => re.test(text);
  return [
    { key: 'rol', labelKey: 'lint.role', ok: head(/#\s*(rol|role)/i) || inc('sen bir', 'sensin', 'görevin', 'you are', 'your role', 'act as') },
    { key: 'gorev', labelKey: 'lint.task', ok: head(/#\s*(görev|task)/i) || inc('yanıtla', 'çöz', 'çıkar', 'oluştur', 'yardım et', 'respond', 'solve', 'extract', 'generate', 'help') },
    { key: 'kural', labelKey: 'lint.rule', ok: head(/#\s*(kural|kısıt|yasak|rule|constraint|prohibit)/i) || inc('asla', 'yalnız', 'uydurma', 'verme ', 'etme', 'never', 'only', 'do not', "don't", 'must not') },
    { key: 'arac', labelKey: 'lint.tool', ok: head(/#\s*(araç|tool)/i) || inc('araç', 'tool', 'çağır', 'call the', 'invoke') },
    { key: 'cikti', labelKey: 'lint.output', ok: head(/#\s*(çıktı|format|output)/i) || inc('json', 'madde', 'kısa', 'türkçe', ' dil', 'bullet', 'concise', ' language') },
  ];
}

const selCls = 'rounded-md border border-input bg-background px-2 py-1 text-[11px] outline-none cursor-pointer';

/** System prompt editor: mono textarea + template/section/rule inserters + live good-prompt audit.
    Rule and section are SYNCED: rules are placed under the heading they belong to. Controlled component. */
export function PromptEditor({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const { t } = useTranslation('promptEditor');
  const ref = useRef<HTMLTextAreaElement>(null);
  const focusEnd = (next: string) => requestAnimationFrame(() => {
    const el = ref.current; if (el) { el.focus(); el.setSelectionRange(next.length, next.length); }
  });

  // Undo for "clear": the textarea is CONTROLLED, so a programmatic onChange('') never lands in the
  // browser's native undo stack (Ctrl+Z does nothing) — this state stands in for that. Holds the text
  // that was just wiped; the toolbar swaps the "clear" button for "undo" while it's non-null and the
  // value is still empty (see the render condition below — typing new text naturally clears it too).
  const [lastCleared, setLastCleared] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current); }, []);

  const performClear = () => {
    setLastCleared(value);
    onChange('');
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => { setLastCleared(null); undoTimerRef.current = null; }, UNDO_WINDOW_MS);
  };
  // Long prompts confirm first (destructive + irreversible-looking action next to constructive
  // buttons); short drafts clear immediately but still get the undo window.
  const requestClear = () => {
    if (value.length > CLEAR_CONFIRM_THRESHOLD) setConfirmOpen(true);
    else performClear();
  };
  const undoClear = () => {
    if (undoTimerRef.current) { clearTimeout(undoTimerRef.current); undoTimerRef.current = null; }
    if (lastCleared !== null) onChange(lastCleared);
    setLastCleared(null);
  };

  // Template/section/rule content is resolved from i18n keys (see note above) — updates when the language changes.
  const templates = useMemo(() => buildPromptTemplates(t), [t]);
  const sections = useMemo(() => buildPromptSections(t), [t]);
  const snippetGroups = useMemo(() => buildSnippetGroups(t), [t]);

  // Template: injected at the cursor position (adds a line break before it if there isn't one already).
  const insertTemplate = (body: string) => {
    const ta = ref.current;
    const start = ta ? ta.selectionStart : value.length;
    const end = ta ? ta.selectionEnd : value.length;
    const before = value.slice(0, start);
    const nl = before.length && !before.endsWith('\n') ? '\n' : '';
    const chunk = nl + body + '\n';
    const next = before + chunk + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => { const el = ref.current; if (el) { const p = start + chunk.length; el.focus(); el.setSelectionRange(p, p); } });
  };

  const checks = lintPrompt(value);
  const trimmed = value.trim();

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t('addTemplateAriaLabel')} className={selCls} value=""
          onChange={(e) => { const tpl = templates.find((x) => x.label === e.target.value); if (tpl) insertTemplate(tpl.body); }}>
          <option value="">{t('addTemplate')}</option>
          {templates.map((tpl) => <option key={tpl.label} value={tpl.label}>{tpl.label}</option>)}
        </select>
        <select aria-label={t('addSectionAriaLabel')} className={selCls} value=""
          onChange={(e) => { if (e.target.value) { const next = addSection(value, e.target.value); onChange(next); focusEnd(next); } }}>
          <option value="">{t('addSection')}</option>
          {sections.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label={t('addRuleAriaLabel')} className={selCls} value=""
          onChange={(e) => {
            const [sec, ...rest] = e.target.value.split('␟'); // section␟rule (synced: rule goes under the section)
            const rule = rest.join('␟');
            if (sec && rule) { const next = addRuleToSection(value, sec, rule); onChange(next); focusEnd(next); }
          }}>
          <option value="">{t('addRule')}</option>
          {snippetGroups.map((g) => (
            <optgroup key={g.section} label={`# ${g.section}`}>
              {g.items.map((it) => <option key={it} value={`${g.section}␟${it}`}>{it}</option>)}
            </optgroup>
          ))}
        </select>
        {lastCleared !== null && !trimmed ? (
          <button type="button" onClick={undoClear}
            className="ml-auto text-[10px] text-muted-foreground underline hover:text-brand">{t('undo')}</button>
        ) : trimmed ? (
          <button type="button" onClick={requestClear}
            className="ml-auto text-[10px] text-muted-foreground underline hover:text-destructive">{t('clear')}</button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('clearConfirmTitle')}
        description={t('clearConfirmDescription', { count: value.length })}
        confirmLabel={t('clear')}
        destructive
        onConfirm={performClear}
      />
      <textarea
        ref={ref}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={9}
        spellCheck={false}
        placeholder={t('placeholder')}
        className="w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs leading-relaxed outline-none"
      />
      {trimmed && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="text-muted-foreground">{t('auditLabel')}</span>
          {checks.map((c) => <Badge key={c.key} tone={c.ok ? 'success' : 'warning'}>{c.ok ? '✓' : '⚠'} {t(c.labelKey)}</Badge>)}
          <span className="ml-auto font-mono text-muted-foreground">{t('characterCount', { count: value.length })}</span>
        </div>
      )}
    </div>
  );
}

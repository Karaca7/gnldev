// PromptEditor content + good-prompt linting (pure logic, no DOM needed).
// Template/section/rule text is now resolved from i18n keys (see the note above src/views/PromptEditor.tsx)
// — resolved the same way in the test with `i18n.getFixedT('en', 'promptEditor')`.
import { describe, it, expect } from 'vitest';
import i18n from '../src/i18n';
import {
  lintPrompt, addSection, addRuleToSection,
  buildPromptTemplates, buildPromptSections, buildSnippetGroups,
} from '../src/views/PromptEditor';

const t = i18n.getFixedT('en', 'promptEditor');
const PROMPT_TEMPLATES = buildPromptTemplates(t);
const PROMPT_SECTIONS = buildPromptSections(t);
const SNIPPET_GROUPS = buildSnippetGroups(t);

describe('lintPrompt', () => {
  it('empty text → all signals missing (ok=false)', () => {
    const checks = lintPrompt('');
    expect(checks.every((c) => !c.ok)).toBe(true);
    expect(checks.map((c) => c.key)).toEqual(['rol', 'gorev', 'kural', 'arac', 'cikti']);
  });

  it('the RAG template → all signals are satisfied (role/task/rule/tool/output)', () => {
    const rag = PROMPT_TEMPLATES.find((tpl) => tpl.label.includes('RAG'))!;
    const checks = lintPrompt(rag.body);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('WITHOUT a heading, the keyword signal still counts (safe with Turkish characters)', () => {
    // No '# Rol' heading, but "Sen bir" is present → role ok; "aracı çağır" → tool ok; "yalnız/uydurma" → rule ok.
    // (This exercises the linter's Turkish-keyword detection path, so the fixture text below is
    // intentionally Turkish — it is the input under test, not leftover translation debt.)
    const checks = lintPrompt('Sen bir asistan. Emin değilsen aracı çağır. Yalnız veriden yanıtla, uydurma.');
    const by = Object.fromEntries(checks.map((c) => [c.key, c.ok]));
    expect(by.rol).toBe(true);
    expect(by.arac).toBe(true);
    expect(by.kural).toBe(true);
    expect(by.gorev).toBe(true); // "yanıtla"
  });

  it('signals also work for an English prompt (detection is multilingual)', () => {
    // No '# Role' heading, but "you are" is present → role ok; "call the tool" → tool ok; "never/only" → rule ok.
    const checks = lintPrompt('You are an assistant. If unsure, call the relevant tool. Only respond from the data, never make things up.');
    const by = Object.fromEntries(checks.map((c) => [c.key, c.ok]));
    expect(by.rol).toBe(true);
    expect(by.arac).toBe(true);
    expect(by.kural).toBe(true);
    expect(by.gorev).toBe(true); // "respond"
  });

  it('every signal returns a translatable labelKey (not message TEXT — pure/testable)', () => {
    const checks = lintPrompt('');
    expect(checks.map((c) => c.labelKey)).toEqual(['lint.role', 'lint.task', 'lint.rule', 'lint.tool', 'lint.output']);
    for (const c of checks) expect(t(c.labelKey)).toBeTruthy();
  });
});

describe('section ↔ rule sync', () => {
  it('addSection: adds the heading if missing, idempotent if present', () => {
    expect(addSection('', 'Role')).toBe('# Role');
    expect(addSection('# Role\nYou are an assistant.', 'Task')).toBe('# Role\nYou are an assistant.\n\n# Task');
    // already present → unchanged
    expect(addSection('# Role\nx', 'Role')).toBe('# Role\nx');
  });

  it('addRuleToSection: creates the section if missing and puts the rule under it', () => {
    expect(addRuleToSection('', 'Tool usage', 'Do not guess.')).toBe('# Tool usage\n- Do not guess.');
    expect(addRuleToSection('# Role\nX', 'Rules', 'Do not make things up.')).toBe('# Role\nX\n\n# Rules\n- Do not make things up.');
  });

  it('addRuleToSection: adds under the EXISTING section, BEFORE the next heading', () => {
    const text = '# Rules\n- Be concise.\n\n# Output format\nJSON.';
    const out = addRuleToSection(text, 'Rules', 'Do not make things up.');
    expect(out).toBe('# Rules\n- Be concise.\n- Do not make things up.\n\n# Output format\nJSON.');
  });

  it('addRuleToSection: does not add a duplicate "- " prefix', () => {
    expect(addRuleToSection('# Rules', 'Rules', '- Already a bullet.')).toBe('# Rules\n- Already a bullet.');
  });

  it('every snippet group\'s section is a valid PROMPT_SECTIONS heading (taxonomy is in sync)', () => {
    for (const g of SNIPPET_GROUPS) expect(PROMPT_SECTIONS).toContain(g.section);
  });
});

describe('content integrity', () => {
  it('4 templates, none empty, all contain # Role', () => {
    expect(PROMPT_TEMPLATES.length).toBe(4);
    for (const tpl of PROMPT_TEMPLATES) {
      expect(tpl.body.trim().length).toBeGreaterThan(20);
      expect(tpl.body).toContain('# Role');
    }
  });

  it('sections and snippet groups are non-empty; every snippet is a single line', () => {
    expect(PROMPT_SECTIONS.length).toBeGreaterThanOrEqual(6);
    expect(SNIPPET_GROUPS.length).toBeGreaterThanOrEqual(3);
    for (const g of SNIPPET_GROUPS) {
      expect(g.items.length).toBeGreaterThan(0);
      for (const it of g.items) expect(it.includes('\n')).toBe(false);
    }
  });

  it('en/tr namespace key parity: same structure, TR content stays original Turkish', () => {
    const trT = i18n.getFixedT('tr', 'promptEditor');
    const trTemplates = buildPromptTemplates(trT);
    const trSections = buildPromptSections(trT);
    expect(trTemplates.length).toBe(PROMPT_TEMPLATES.length);
    expect(trSections.length).toBe(PROMPT_SECTIONS.length);
    expect(trSections).toContain('Rol'); // TR is preserved verbatim
    expect(PROMPT_SECTIONS).toContain('Role'); // EN native
  });
});

// @vitest-environment jsdom
// Inspector's chat-first "Conversation" view — ChatBubble/ToolCallChips pure render (no fetch stub).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '../src/i18n'; // ChatBubble now uses useTranslation — needs to be initialized in the test too (same pattern as views.test.tsx).
import { ChatBubble, ToolCallChips } from '../src/views/Inspector';

afterEach(cleanup);

describe('ChatBubble', () => {
  it('assistant: shows the text + tool-call chip + token/latency', () => {
    const m = { role: 'assistant', content: [
      { type: 'text', text: 'Calling the tool' },
      { type: 'tool-call', toolName: 'searchResource', input: { q: 'vader' } },
    ] };
    const entry = { key: 'r:model:1', runId: 'r', kind: 'model' as const, seq: 1, ts: 100, value: { usage: { totalTokens: 42 } } };
    render(<ChatBubble m={m} entry={entry} latencyMs={1200} />);
    expect(screen.getAllByText(/Calling the tool/).length).toBeGreaterThan(0); // bubble text (+ also appears in the raw JSON)
    expect(screen.getByText('searchResource')).toBeTruthy();     // tool-call card: tool name
    expect(screen.getByText('q:')).toBeTruthy();                 // arg readable as key: value
    expect(screen.getAllByText(/vader/).length).toBeGreaterThan(0);
    expect(screen.getByText(/42 tok/)).toBeTruthy();
    expect(screen.getByText(/1\.20s/)).toBeTruthy();             // fmtSpanMs(1200)
  });

  it('user: right-aligned (ml-auto) bubble', () => {
    const { container } = render(<ChatBubble m={{ role: 'user', content: 'Who is Vader?' }} />);
    expect(screen.getByText('Who is Vader?')).toBeTruthy();
    expect(container.querySelector('.ml-auto')).toBeTruthy();
  });

  it('tool: ✗ (red) status icon on a failed result', () => {
    const m = { role: 'tool', tool_call_id: 'c1', content: 'error' };
    const entry = { key: 'r:tool:c1', runId: 'r', kind: 'tool' as const, seq: 2, value: { status: 'failed' } };
    render(<ChatBubble m={m} entry={entry} />);
    expect(screen.getByText('✗')).toBeTruthy();
  });

  it('system: collapsed (details) — summary "system prompt" (EN default)', () => {
    render(<ChatBubble m={{ role: 'system', content: 'You are an assistant' }} />);
    expect(screen.getByText('system prompt')).toBeTruthy();
  });
});

describe('ToolCallChips', () => {
  it('returns null when there is no tool-call part', () => {
    const { container } = render(<ToolCallChips content={[{ type: 'text', text: 'x' }]} />);
    expect(container.firstChild).toBeNull();
  });
  it('null when not an array', () => {
    const { container } = render(<ToolCallChips content={'plain text'} />);
    expect(container.firstChild).toBeNull();
  });
});

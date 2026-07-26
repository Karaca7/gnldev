// @vitest-environment node
// F6.5: Playground attachment size limit + extracting tool parts from history, Knowledge minScore threshold — PURE functions.
import { describe, it, expect } from 'vitest';
import { MAX_ATTACHMENT_BYTES, validateAttachment, mapMessages, matchToolResult, applyToolOutcome, activityFromEvent, fmtElapsed, userOrdinalAt, userMessageServerIndex, type Msg } from '../src/views/Playground';
import { filterByMinScore, clampTopK, clampMinScore } from '../src/views/Knowledge';
import { validateToolInput, coerceToolField } from '../src/views/Tools';

describe('validateAttachment', () => {
  it('accepts a file under the 5MB limit', () => {
    expect(validateAttachment({ size: MAX_ATTACHMENT_BYTES - 1, type: 'image/png' })).toEqual({ ok: true });
    expect(validateAttachment({ size: 1024 })).toEqual({ ok: true });
  });

  it('accepts a file exactly at the limit (>=, not >)', () => {
    expect(validateAttachment({ size: MAX_ATTACHMENT_BYTES })).toEqual({ ok: true });
  });

  it('rejects a file over 5MB with a clear reason', () => {
    const r = validateAttachment({ size: MAX_ATTACHMENT_BYTES + 1, type: 'application/pdf' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/5 MB/);
  });
});

describe('mapMessages — preserves past tool steps', () => {
  it('turns plain-text user/assistant messages into bubbles as before', () => {
    const data = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(mapMessages(data)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ]);
  });

  it('opens an assistant tool-call, matches the tool-result in a separate role:tool message by toolCallId and writes the output', () => {
    const data = [
      { role: 'user', content: 'how\'s the weather?' },
      { role: 'assistant', content: [
        { type: 'text', text: 'checking' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'ist' } },
      ] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', output: { tempC: 21 } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'Istanbul 21°C' }] },
    ];
    expect(mapMessages(data)).toEqual([
      { role: 'user', text: 'how\'s the weather?' },
      { role: 'assistant', text: 'checking' },
      { role: 'tool', name: 'weather', input: { city: 'ist' }, output: { tempC: 21 } },
      { role: 'assistant', text: 'Istanbul 21°C' },
    ]);
  });

  it('a tool-error is also written to the output field (wrapped as error)', () => {
    const data = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-2', toolName: 'broken', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-error', toolCallId: 'call-2', toolName: 'broken', error: 'boom' }] },
    ];
    expect(mapMessages(data)).toEqual([
      { role: 'tool', name: 'broken', input: {}, output: { error: 'boom' } },
    ]);
  });

  it('an unmatched toolCallId → added as a new tool message (no data loss)', () => {
    const data = [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'orphan', toolName: 'x', output: 1 }] },
    ];
    expect(mapMessages(data)).toEqual([
      { role: 'tool', name: 'x', input: undefined, output: 1 },
    ]);
  });

  it('does not crash on empty/missing data', () => {
    expect(mapMessages([])).toEqual([]);
    expect(mapMessages(undefined as unknown as any[])).toEqual([]);
  });
});

// FLOW-10: local msgs index ↔ server /threads/:id/messages index are NOT 1:1 (a single assistant
// server entry fans out into several local Msg entries — interleaved text/tool-call blocks). These
// two pure functions anchor edit/regenerate's server-side truncation on "the Nth user turn" instead,
// which IS the same ordinal on both sides.
describe('userOrdinalAt / userMessageServerIndex — local↔server index mapping for edit/regenerate', () => {
  it('userOrdinalAt: counts user messages up to and including the target index', () => {
    const msgs: Msg[] = [
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
      { role: 'tool', name: 'x', input: {}, output: 1 },
      { role: 'assistant', text: 'a1 continued' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'a2' },
    ];
    expect(userOrdinalAt(msgs, 0)).toBe(0); // q1 is the 0th user turn
    expect(userOrdinalAt(msgs, 4)).toBe(1); // q2 is the 1st user turn, despite being local index 4
  });

  it('userMessageServerIndex: finds the Nth user turn in the RAW server array, skipping fanned-out assistant/tool entries', () => {
    // Mirrors the local `msgs` above: one assistant server turn (text + tool-call) fans out into 3
    // local Msg entries (assistant/tool/assistant), but is still a SINGLE entry here.
    const data = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [
        { type: 'text', text: 'a1' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: {} },
      ] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'x', output: 1 }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1 continued' }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ];
    expect(userMessageServerIndex(data, 0)).toBe(0); // q1
    expect(userMessageServerIndex(data, 1)).toBe(4); // q2 — server index 4, NOT local index 4
  });

  it('userMessageServerIndex: skips a user entry with empty text (mapMessages would skip it too)', () => {
    const data = [
      { role: 'user', content: '' },
      { role: 'user', content: 'real question' },
    ];
    expect(userMessageServerIndex(data, 0)).toBe(1);
  });

  it('userMessageServerIndex: out-of-range ordinal → -1 (caller must not guess an index)', () => {
    const data = [{ role: 'user', content: 'only one' }];
    expect(userMessageServerIndex(data, 1)).toBe(-1);
    expect(userMessageServerIndex([], 0)).toBe(-1);
  });
});

describe('filterByMinScore', () => {
  const results = [
    { id: 'a', text: 'a', score: 0.9 },
    { id: 'b', text: 'b', score: 0.4 },
    { id: 'c', text: 'c', score: 0.1 },
  ];

  it('minScore 0/negative → no filter applied', () => {
    expect(filterByMinScore(results, 0)).toEqual(results);
    expect(filterByMinScore(results, -1)).toEqual(results);
  });

  it('filters out results below the threshold, keeps ones equal to it', () => {
    expect(filterByMinScore(results, 0.4)).toEqual([results[0], results[1]]);
  });

  it('returns an empty array when no result clears the threshold', () => {
    expect(filterByMinScore(results, 0.95)).toEqual([]);
  });
});

describe('clampTopK / clampMinScore — clamping on blur/submit', () => {
  it('clampTopK: keeps an in-range integer', () => {
    expect(clampTopK('10')).toBe(10);
  });
  it('clampTopK: clamps out-of-range values, rounds decimals', () => {
    expect(clampTopK('0')).toBe(1);
    expect(clampTopK('999')).toBe(50);
    expect(clampTopK('3.7')).toBe(4);
  });
  it('clampTopK: invalid/empty input → default (5)', () => {
    expect(clampTopK('')).toBe(5);
    expect(clampTopK('abc')).toBe(5);
  });

  it('clampMinScore: keeps the [0,1] range', () => {
    expect(clampMinScore('0.4')).toBe(0.4);
  });
  it('clampMinScore: clamps out-of-range values', () => {
    expect(clampMinScore('-1')).toBe(0);
    expect(clampMinScore('5')).toBe(1);
  });
  it('clampMinScore: invalid/empty input → 0', () => {
    expect(clampMinScore('')).toBe(0);
    expect(clampMinScore('abc')).toBe(0);
  });
});

describe('matchToolResult — id-based matching for streaming tool-results', () => {
  const msgs: Msg[] = [
    { role: 'user', text: 'ask for the weather in two cities' },
    { role: 'tool', name: 'weather', input: { city: 'ist' }, toolCallId: 'call-1' },
    { role: 'tool', name: 'weather', input: { city: 'ank' }, toolCallId: 'call-2' },
  ];

  it('finds the correct toolCallId index for parallel tool calls (order does NOT matter)', () => {
    expect(matchToolResult(msgs, 'call-2')).toBe(2);
    expect(matchToolResult(msgs, 'call-1')).toBe(1);
  });

  it('returns -1 when there is no match (so the caller does not write unconditionally and corrupt messages)', () => {
    expect(matchToolResult(msgs, 'call-99')).toBe(-1);
  });

  it('returns -1 when no toolCallId is given (does not guess "the last one" like the old heuristic)', () => {
    expect(matchToolResult(msgs, undefined)).toBe(-1);
  });

  it('a tool that already has output matches the same id again (idempotent update)', () => {
    const withOutput: Msg[] = [...msgs];
    (withOutput[1] as any).output = { tempC: 21 };
    expect(matchToolResult(withOutput, 'call-1')).toBe(1);
  });
});

describe('coerceToolField / validateToolInput — Tools form validation', () => {
  it('coerceToolField: an empty/untouched number field → undefined (NOT NaN)', () => {
    expect(coerceToolField({ type: 'number' }, undefined)).toBeUndefined();
    expect(coerceToolField({ type: 'number' }, '')).toBeUndefined();
  });
  it('coerceToolField: converts a valid number string', () => {
    expect(coerceToolField({ type: 'integer' }, '42')).toBe(42);
  });
  it('coerceToolField: converts boolean/string fields as before', () => {
    expect(coerceToolField({ type: 'boolean' }, 'true')).toBe(true);
    expect(coerceToolField({ type: 'boolean' }, 'false')).toBe(false);
    expect(coerceToolField({ type: 'string' }, 'hello')).toBe('hello');
  });

  it('validateToolInput: returns the coerced input for valid input', () => {
    const fields = [{ key: 'n', type: 'number', required: true }, { key: 's', type: 'string', required: false }];
    expect(validateToolInput(fields, { n: '5', s: 'x' })).toEqual({ ok: true, input: { n: 5, s: 'x' } });
  });

  it('validateToolInput: an invalid number (produces NaN) → rejected, field listed as invalid', () => {
    const fields = [{ key: 'n', type: 'number', required: false }];
    const r = validateToolInput(fields, { n: 'abc' });
    expect(r).toEqual({ ok: false, invalid: ['n'] });
  });

  it('validateToolInput: an empty required field is rejected (before going to the server)', () => {
    const fields = [{ key: 'name', type: 'string', required: true }];
    const r = validateToolInput(fields, {});
    expect(r).toEqual({ ok: false, invalid: ['name'] });
  });

  it('validateToolInput: an empty optional field is silently dropped (not included in input)', () => {
    const fields = [{ key: 'name', type: 'string', required: true }, { key: 'note', type: 'string', required: false }];
    expect(validateToolInput(fields, { name: 'x', note: '' })).toEqual({ ok: true, input: { name: 'x' } });
  });
});

describe('activityFromEvent — what the run is doing right now', () => {
  it('brackets a thinking phase with reasoning-start/end', () => {
    expect(activityFromEvent('reasoning-start')).toEqual({ kind: 'reasoning' });
    // Thinking is over, but nothing has been produced yet — back to waiting, NOT to idle.
    expect(activityFromEvent('reasoning-end')).toEqual({ kind: 'waiting' });
  });

  it('separates composing a tool call from executing it', () => {
    // These are different waits: the first is the model, the second is our own code.
    expect(activityFromEvent('tool-input-start', { toolName: 'search' })).toEqual({ kind: 'tool-input', name: 'search' });
    expect(activityFromEvent('tool-call', { toolName: 'search' })).toEqual({ kind: 'tool-run', name: 'search' });
  });

  it('returns to waiting when a tool finishes, whether it succeeded or failed', () => {
    expect(activityFromEvent('tool-result', { toolName: 'search' })).toEqual({ kind: 'waiting' });
    expect(activityFromEvent('tool-error', { toolName: 'search' })).toEqual({ kind: 'waiting' });
  });

  it('reports writing on text, and a new step as waiting', () => {
    expect(activityFromEvent('text-delta')).toEqual({ kind: 'writing' });
    expect(activityFromEvent('step-start')).toEqual({ kind: 'waiting' });
  });

  it('returns undefined — not null — for events that say nothing about the current phase', () => {
    // null would mean "idle" and blank the indicator mid-run; undefined tells the caller to leave
    // the current state alone. The difference is a flicker to "nothing is happening" on every
    // interrupt/done/source event.
    for (const t of ['interrupt', 'done', 'source', 'file', 'raw', 'step-finish', 'reasoning-delta']) {
      expect(activityFromEvent(t)).toBeUndefined();
    }
  });

  it('survives a tool event with no toolName rather than throwing', () => {
    expect(activityFromEvent('tool-call', {})).toEqual({ kind: 'tool-run', name: '' });
    expect(activityFromEvent('tool-input-start')).toEqual({ kind: 'tool-input', name: undefined });
  });
});

describe('fmtElapsed', () => {
  it('counts in seconds below a minute', () => {
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(8_400)).toBe('8s');      // truncates, never rounds up past the real elapsed
    expect(fmtElapsed(59_999)).toBe('59s');
  });

  it('switches to m:ss at a minute, zero-padding the seconds', () => {
    expect(fmtElapsed(60_000)).toBe('1:00');
    expect(fmtElapsed(67_000)).toBe('1:07');
    expect(fmtElapsed(600_000)).toBe('10:00');
  });

  it('clamps a negative delta to zero instead of printing "-1s"', () => {
    // Reachable if the clock steps backwards between startedAt and the first tick.
    expect(fmtElapsed(-5_000)).toBe('0s');
  });
});

describe('applyToolOutcome — a finished tool must leave the "running" state', () => {
  const base: Msg[] = [
    { role: 'user', text: 'search please' },
    { role: 'tool', name: 'search', input: { q: 'x' }, toolCallId: 'c1' },
    { role: 'tool', name: 'fetch', input: { u: 'y' }, toolCallId: 'c2' },
  ];

  it('writes a successful result onto the matching call', () => {
    const out = applyToolOutcome(base, 'c1', { hits: 3 });
    expect((out[1] as any).output).toEqual({ hits: 3 });
    expect((out[2] as any).output).toBeUndefined(); // the other call is untouched
  });

  it('REGRESSION: a tool ERROR also lands an output, so the card stops pulsing "running"', () => {
    // MsgBlock renders the live pulse from `output === undefined`. Before the fix the tool-error
    // event was dropped entirely, so this stayed undefined and the tool claimed to be running for
    // the rest of the session — the single worst version of "I can't tell if it's still working".
    const out = applyToolOutcome(base, 'c2', { error: 'boom' });
    expect((out[2] as any).output).toEqual({ error: 'boom' });
    expect((out[2] as any).output).toBeDefined();
  });

  it('matches the shape mapMessages produces for a reloaded tool-error, so both paths agree', () => {
    const reloaded = mapMessages([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c9', toolName: 'search', input: { q: 'x' } }] },
      { role: 'tool', content: [{ type: 'tool-error', toolCallId: 'c9', toolName: 'search', error: 'boom' }] },
    ]);
    const live = applyToolOutcome(
      [{ role: 'tool', name: 'search', input: { q: 'x' }, toolCallId: 'c9' }],
      'c9',
      { error: 'boom' },
    );
    const reloadedTool = reloaded.find((m) => m.role === 'tool') as any;
    expect(reloadedTool.output).toEqual((live[0] as any).output);
  });

  it('leaves the list alone (same reference) when the id matches nothing', () => {
    expect(applyToolOutcome(base, 'nope', { x: 1 })).toBe(base);
    expect(applyToolOutcome(base, undefined, { x: 1 })).toBe(base);
  });

  it('does not mutate the previous state — the updated message is a NEW object', () => {
    const out = applyToolOutcome(base, 'c1', { hits: 3 });
    expect(out).not.toBe(base);
    expect(out[1]).not.toBe(base[1]);            // identity changes → memoized children re-render
    expect((base[1] as any).output).toBeUndefined(); // the old state stays as it was
  });
});

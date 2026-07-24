// @vitest-environment jsdom
// Lightweight line-diff (S4): diffLines LCS alignment + TextDiff unified render.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { diffLines, TextDiff } from '../src/text-diff';

afterEach(cleanup);

describe('diffLines', () => {
  it('identical text → everything is same', () => {
    const ops = diffLines('a\nb\nc', 'a\nb\nc');
    expect(ops).toEqual([
      { type: 'same', text: 'a' }, { type: 'same', text: 'b' }, { type: 'same', text: 'c' },
    ]);
  });

  it('a line changed in the middle → del+add, prefix/suffix stay same', () => {
    const ops = diffLines('title\nold line\nend', 'title\nnew line\nend');
    expect(ops).toEqual([
      { type: 'same', text: 'title' },
      { type: 'del', text: 'old line' },
      { type: 'add', text: 'new line' },
      { type: 'same', text: 'end' },
    ]);
  });

  it('inserting a line in between is aligned via LCS (existing lines don\'t become del+add)', () => {
    const ops = diffLines('a\nc', 'a\nb\nc');
    expect(ops).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('line deletion', () => {
    const ops = diffLines('a\nb\nc', 'a\nc');
    expect(ops).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('empty ↔ non-empty edge cases', () => {
    expect(diffLines('', 'x')).toEqual([{ type: 'del', text: '' }, { type: 'add', text: 'x' }]);
    expect(diffLines('x', '')).toEqual([{ type: 'del', text: 'x' }, { type: 'add', text: '' }]);
    expect(diffLines('', '')).toEqual([{ type: 'same', text: '' }]);
  });

  it('the DP is skipped on huge input, but the result is still honest (fallback del+add)', () => {
    // 600×600 fully different core lines > 200k cells → fallback path.
    const a = Array.from({ length: 600 }, (_, i) => `A${i}`).join('\n');
    const b = Array.from({ length: 600 }, (_, i) => `B${i}`).join('\n');
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.type === 'del')).toHaveLength(600);
    expect(ops.filter((o) => o.type === 'add')).toHaveLength(600);
  });
});

describe('TextDiff component', () => {
  it('unified view: gutter markers and data-diff-line types', () => {
    const { container } = render(<TextDiff a={'a\nold\nc'} b={'a\nnew\nc'} />);
    const rows = [...container.querySelectorAll('[data-diff-line]')];
    expect(rows.map((r) => r.getAttribute('data-diff-line'))).toEqual(['same', 'del', 'add', 'same']);
    expect(rows[1]!.textContent).toContain('−');
    expect(rows[1]!.textContent).toContain('old');
    expect(rows[2]!.textContent).toContain('+');
    expect(rows[2]!.textContent).toContain('new');
  });

  it('renders nothing when there is no difference', () => {
    const { container } = render(<TextDiff a={'same'} b={'same'} />);
    expect(container.firstChild).toBeNull();
  });
});

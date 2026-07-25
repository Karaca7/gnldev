// @vitest-environment jsdom
// Bug-investigation fix #5 (StatusBadge) + #6 (JsonBlock): unknown/null data no longer shows a
// false positive (fail-open to green / literal "null"-"undefined") — neutral instead.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StatusBadge, JsonBlock, StatStrip, Tabs, ErrorBox } from '../src/components';
import { ApiError } from '../src/api';
import '../src/i18n'; // EN default language so JsonBlock's t('noData') call uses the real translation (test-side counterpart of the side effect in main.tsx).

afterEach(cleanup);

describe('StatusBadge (bug investigation #5)', () => {
  it('completed is green (success); running is a distinct cool blue (info), not green', () => {
    render(<StatusBadge status="completed" />);
    expect(screen.getByText('completed').className).toContain('text-success');
    cleanup();
    // Running is deliberately INFO (blue) so it is not visually identical to completed (both were green before).
    render(<StatusBadge status="running" />);
    const running = screen.getByText('running').className;
    expect(running).toContain('text-info');
    expect(running).not.toContain('text-success');
  });

  it('known error/warning statuses are unchanged', () => {
    render(<StatusBadge status="suspended" />);
    expect(screen.getByText('suspended').className).toContain('text-warning');
    cleanup();
    render(<StatusBadge status="failed" />);
    expect(screen.getByText('failed').className).toContain('text-destructive');
  });

  it('an unknown status does NOT fail-open to green — shown neutral (muted)', () => {
    render(<StatusBadge status="weird-unknown-status" />);
    const el = screen.getByText('weird-unknown-status');
    expect(el.className).not.toContain('text-success');
    expect(el.className).toContain('text-muted-foreground');
  });
});

describe('JsonBlock (bug investigation #6)', () => {
  it('null → "No data", not the literal "null"', () => {
    render(<JsonBlock value={null} />);
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.queryByText('null')).toBeNull();
  });

  it('undefined → "No data", not the literal "undefined"', () => {
    render(<JsonBlock value={undefined} />);
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.queryByText('undefined')).toBeNull();
  });

  it('a valid object still renders normally (no regression)', () => {
    render(<JsonBlock value={{ a: 1 }} />);
    expect(screen.getByText('a')).toBeTruthy();
  });
});

describe('ErrorBox (STATE-10)', () => {
  it('shows the clean server message, not the "ApiError:" technical prefix', () => {
    render(<ErrorBox error={new ApiError(402, 'organization budget exceeded')} />);
    // errMessage() strips the "ApiError:" prefix String(error) used to add — only ErrorBox's own
    // t('errorPrefix') label ("Error") should appear, never doubled up with the class name.
    expect(screen.getByText('Error: organization budget exceeded')).toBeTruthy();
    expect(screen.queryByText(/ApiError/)).toBeNull();
  });
});

describe('StatStrip (VIS-04)', () => {
  it('the value carries a title attribute with the full text (recoverable when truncate clips it)', () => {
    render(<StatStrip items={[{ label: 'Cost', value: '$1234.5678' }]} />);
    const value = screen.getByText('$1234.5678');
    expect(value.getAttribute('title')).toBe('$1234.5678');
  });
});

describe('Tabs (A11Y-06)', () => {
  const tabs = [
    { id: 'journal', label: 'Journal' },
    { id: 'trace', label: 'Trace' },
    { id: 'cost', label: 'Cost' },
  ] as const;

  it('uses the real ARIA tabs pattern: role="tablist" wrapper, role="tab" + aria-selected on each tab', () => {
    render(<Tabs tabs={[...tabs]} active="trace" onChange={() => {}} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    const journal = screen.getByRole('tab', { name: 'Journal' });
    const trace = screen.getByRole('tab', { name: 'Trace' });
    expect(trace.getAttribute('aria-selected')).toBe('true');
    expect(journal.getAttribute('aria-selected')).toBe('false');
  });

  it('roving tabindex: only the selected tab is Tab-key reachable (tabIndex 0), the rest are -1', () => {
    render(<Tabs tabs={[...tabs]} active="cost" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Cost' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Journal' }).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tab', { name: 'Trace' }).getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowRight/ArrowLeft move selection AND focus between tabs (roving tabindex requires moving focus too)', () => {
    let active: string = 'journal';
    const onChange = (id: string) => { active = id; };
    const { rerender } = render(<Tabs tabs={[...tabs]} active={active} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Journal' }), { key: 'ArrowRight' });
    expect(active).toBe('trace');
    rerender(<Tabs tabs={[...tabs]} active={active} onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'Trace' })).toBe(document.activeElement);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Trace' }), { key: 'ArrowLeft' });
    expect(active).toBe('journal');
    rerender(<Tabs tabs={[...tabs]} active={active} onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'Journal' })).toBe(document.activeElement);
  });
});

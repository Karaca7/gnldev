// @vitest-environment jsdom
// Bug-investigation fix #5 (StatusBadge) + #6 (JsonBlock): unknown/null data no longer shows a
// false positive (fail-open to green / literal "null"-"undefined") — neutral instead.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusBadge, JsonBlock } from '../src/components';
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

// @vitest-environment jsdom
// PromptEditor "clear" regression (FORM-11): programmatic onChange('') never lands in the browser's
// native undo stack (controlled textarea), so a raw one-click clear was a silent, irrecoverable data
// loss right next to the constructive template/section/rule inserters. Covers: long text → clear
// asks for confirmation before wiping, short text clears instantly, and either path exposes a
// timed "undo" that restores the wiped text.
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '../src/i18n';
import { PromptEditor } from '../src/views/PromptEditor';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// PromptEditor is a controlled component (props signature untouched — value/onChange/id) — this
// wrapper supplies the state the real "create agent" form would.
function Wrapper({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <PromptEditor value={value} onChange={setValue} />;
}

describe('PromptEditor clear (long text)', () => {
  it('text over 200 chars: clicking clear opens a confirm dialog instead of wiping immediately', async () => {
    const long = 'x'.repeat(201);
    render(<Wrapper initial={long} />);
    fireEvent.click(screen.getByText('clear'));

    // Confirmation dialog appeared — text is untouched.
    await screen.findByText("Clear the system prompt?");
    expect((screen.getByPlaceholderText(/Can be left empty/) as HTMLTextAreaElement).value).toBe(long);

    // Confirm — the LAST "clear" on screen is the dialog's confirm button (same pattern as cache-view.test.tsx).
    const confirmBtn = (await screen.findAllByText('clear')).at(-1)!;
    fireEvent.click(confirmBtn);

    // Text is wiped, and an "undo" affordance takes the toolbar button's place.
    const textarea = screen.getByPlaceholderText(/Can be left empty/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    const undoBtn = await screen.findByText('undo');

    // Undo restores the exact wiped text.
    fireEvent.click(undoBtn);
    expect(textarea.value).toBe(long);
    expect(screen.queryByText('undo')).toBeNull();
  });

  it('cancelling the confirm dialog leaves the text untouched (no clear happened)', async () => {
    const long = 'y'.repeat(250);
    render(<Wrapper initial={long} />);
    fireEvent.click(screen.getByText('clear'));
    await screen.findByText("Clear the system prompt?");

    fireEvent.click(screen.getByText('Cancel'));

    const textarea = screen.getByPlaceholderText(/Can be left empty/) as HTMLTextAreaElement;
    expect(textarea.value).toBe(long);
    expect(screen.queryByText('undo')).toBeNull();
  });
});

describe('PromptEditor clear (short text)', () => {
  it('text at/under 200 chars clears immediately (no confirm dialog) but still offers undo', async () => {
    const short = 'short system prompt';
    render(<Wrapper initial={short} />);
    fireEvent.click(screen.getByText('clear'));

    expect(screen.queryByText('Clear the system prompt?')).toBeNull();
    const textarea = screen.getByPlaceholderText(/Can be left empty/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    const undoBtn = await screen.findByText('undo');
    fireEvent.click(undoBtn);
    expect(textarea.value).toBe(short);
  });

  it('typing new text after a clear dismisses the undo affordance', async () => {
    const short = 'short system prompt';
    render(<Wrapper initial={short} />);
    fireEvent.click(screen.getByText('clear'));
    await screen.findByText('undo');

    const textarea = screen.getByPlaceholderText(/Can be left empty/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'new draft' } });

    expect(screen.queryByText('undo')).toBeNull();
    expect(screen.getByText('clear')).toBeTruthy();
  });

  it('the undo affordance expires after the undo window elapses', async () => {
    vi.useFakeTimers();
    const short = 'short system prompt';
    render(<Wrapper initial={short} />);
    fireEvent.click(screen.getByText('clear'));
    expect(screen.getByText('undo')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(10_000); });

    expect(screen.queryByText('undo')).toBeNull();
  });
});

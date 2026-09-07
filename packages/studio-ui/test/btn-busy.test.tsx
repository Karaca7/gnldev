// @vitest-environment jsdom
// A button that is waiting on the network has to LOOK like it is waiting.
//
// The state already existed everywhere — every screen tracks its pending flag — but it was handed
// to `disabled`, so the button greyed out and nothing moved. Greyed-out-and-still is what a dead
// control looks like; on a slow call it is indistinguishable from a page that stopped responding,
// and the honest reading of a click that produced no visible change is "it didn't work".
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Btn } from '../src/components';

afterEach(cleanup);

describe('a button waiting on the API', () => {
  it('spins, and says so to a screen reader', () => {
    render(<Btn busy>Kaydet</Btn>);
    const btn = screen.getByRole('button', { name: /Kaydet/ });

    expect(btn.getAttribute('aria-busy')).toBe('true');
    // Something actually moves. The spinner is decorative, so it is found in the markup rather
    // than by role — but it has to be there and it has to animate.
    expect(btn.querySelector('.animate-spin')).toBeTruthy();
  });

  it('stays un-clickable while it spins', () => {
    // The spinner replaces the disabled state as a SIGNAL, not as a guard: a second click on a
    // half-finished action is the thing `disabled` was there to stop.
    render(<Btn busy>Kaydet</Btn>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows nothing spinning when it is merely disabled', () => {
    // "You cannot do this" and "this is happening" are different messages. A spinner on a button
    // that is simply unavailable would promise progress that is not coming.
    render(<Btn disabled>Kaydet</Btn>);
    const btn = screen.getByRole('button');

    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBeNull();
    expect(btn.querySelector('.animate-spin')).toBeNull();
  });

  it('drops the decorative arrow while busy so the two do not stack', () => {
    const { rerender } = render(<Btn arrow>Run</Btn>);
    expect(screen.getByRole('button').textContent).toContain('›');

    rerender(<Btn arrow busy>Run</Btn>);
    expect(screen.getByRole('button').textContent).not.toContain('›');
  });
});

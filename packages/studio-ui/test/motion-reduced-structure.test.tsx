// @vitest-environment jsdom
// `prefers-reduced-motion: reduce` must change the ANIMATION, not the markup.
//
// Both `Stagger` and `StaggerItem` accept an `as` element and used to DISCARD it on the reduced-motion
// branch, returning a bare `<div>`. Four views pass `motion.tbody` / `motion.tr` (Jobs, Scheduler,
// Observability, Dead-letter), so under the preference the tables rendered as
// `<table><thead>…</thead><div><div>…</div></div></table>`: the row group and every row became divs,
// the cells lost their row context, and the table stopped being a table to assistive technology.
//
// The trigger is an ACCESSIBILITY PREFERENCE, so the users it broke the table for are the ones most
// likely to be reading through the structure it destroyed. Nothing else in the suite looks at the
// reduced-motion branch — it renders "something" either way, and only the tag differs.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { motion } from 'framer-motion';
import { Stagger, StaggerItem } from '../src/motion';

/** framer-motion's `useReducedMotion` reads this media query; jsdom ships no matchMedia at all. */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduce : false,
    media: query,
    onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const table = () => (
  <table>
    <thead><tr><th>h</th></tr></thead>
    <Stagger as={motion.tbody}>
      <StaggerItem as={motion.tr}><td>cell</td></StaggerItem>
    </Stagger>
  </table>
);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { cleanup(); });

describe('Stagger / StaggerItem under prefers-reduced-motion', () => {
  /**
   * ONLY the reduced branch is exercised here, and that is a limitation worth stating rather than
   * papering over: framer-motion resolves the preference into a module-level singleton on first use,
   * so a second case in the same process would still see whatever the first one stubbed — a
   * "full motion" row would pass without ever leaving the reduced branch. The full-motion structure
   * is covered for real by the four view tests that query these tables by row (jobs-view,
   * scheduler-view, dead-events-view, observability), which run with no matchMedia stub at all.
   */
  it('keeps the table a table', async () => {
    stubReducedMotion(true);
    const { container } = render(table());

    expect(container.querySelector('table > tbody'), 'the row group is not a <tbody> under reduced motion').toBeTruthy();
    expect(container.querySelector('tbody > tr'), 'the row is not a <tr>').toBeTruthy();
    expect(container.querySelector('tr > td')?.textContent).toBe('cell');
    expect(container.querySelector('table > div'), 'a <div> was spliced between <table> and its rows').toBeNull();
  });

  it('still defaults to a <div> when no `as` is given', () => {
    // The default must not change: most call sites are lists and cards, not tables.
    stubReducedMotion(true);
    const { container } = render(<Stagger><StaggerItem>x</StaggerItem></Stagger>);
    expect(container.firstElementChild?.tagName).toBe('DIV');
  });
});

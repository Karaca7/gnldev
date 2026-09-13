// A step whose output came from `retry(..., { fallback })` used to be indistinguishable from one that
// succeeded on its own.
//
// The fallback's output is journaled under the RETRIED step's id, so `runWorkflow`'s step list — what
// Studio renders — showed "charged via provider A" identically whether that step worked first time or
// blew up twice and landed on provider B. The `:attempts` counter next to it does not close the gap:
// On a backend with `incrBy` it lives in a counter map rather than the field, and the reader that
// knows the difference is in @gnldev/workflow, which registry.ts must not import (a reverse
// dependency would be circular — see its structural-type note).
//
// So @gnldev/workflow writes a plain marker and registry.ts reads it with a plain `get`. Both halves
// are exercised HERE, with the real `retry`, because the thing most likely to rot is the two packages
// agreeing on the key name — and a test that stubbed one side would keep passing through exactly that.
import { describe, it, expect } from 'vitest';
import { workflow, step, retry, asStep, forkWorkflowRun } from '@gnldev/workflow';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';

const boom = step('charge', async () => { throw new Error('provider A is down'); });

describe('a fallback substitution is visible in the workflow run record', () => {
  it('names the substitute step and how many attempts preceded it', async () => {
    const journal = new InMemoryJournal();
    const wf = workflow().then(
      retry(boom, { attempts: 2, fallback: step('chargeViaB', async () => ({ charged: true, via: 'B' })) }),
    );
    const gnl = createGnl({ journal, workflows: { pay: wf as any } });

    const res = await gnl.runWorkflow('pay', {}, { runId: 'wf-fb-1' });
    const charge = res.steps.find((s) => s.id === 'charge');

    // The output on its own still reads like an ordinary success — which is the whole problem.
    expect(charge?.output).toEqual({ charged: true, via: 'B' });
    // ...so the record says where it came from.
    expect(charge?.fallback).toEqual({ attempts: 2, stepId: 'chargeViaB' });
  });

  it('a step that produced its own output carries no marker', async () => {
    const journal = new InMemoryJournal();
    let tries = 0;
    const flaky = step('charge', async () => {
      tries++;
      if (tries === 1) throw new Error('transient');
      return { charged: true, via: 'A' };
    });
    const wf = workflow().then(
      retry(flaky, { attempts: 3, fallback: step('chargeViaB', async () => ({ charged: true, via: 'B' })) }),
    );
    const gnl = createGnl({ journal, workflows: { pay: wf as any } });

    const res = await gnl.runWorkflow('pay', {}, { runId: 'wf-fb-2' });
    const charge = res.steps.find((s) => s.id === 'charge');

    expect(charge?.output).toEqual({ charged: true, via: 'A' });
    // It was retried, but it was never substituted — the two must not read the same.
    expect(charge?.fallback, 'a retry is not a substitution').toBeUndefined();
  });
});

// A marker that can be forged is worse than no marker: the first fails to answer, the second answers
// wrongly. Each of these produced a fabricated `fallback` before the key was moved into the reserved
// `_` namespace and the brand was checked.
describe('the marker cannot be fabricated', () => {
  it('an inner step literally named `fallback` is not mistaken for one', async () => {
    const journal = new InMemoryJournal();
    // Its output lands at `<runId>:wf:payment:fallback` — which an unprefixed marker key also was.
    const inner = workflow().then(step('fallback', async () => ({ ok: true })));
    const gnl = createGnl({ journal, workflows: { pay: workflow().then(asStep('payment', inner as any)) as any } });

    const res = await gnl.runWorkflow('pay', {}, { runId: 'wf-forge-1' });
    expect(res.steps[0].output).toEqual({ ok: true });
    expect(res.steps[0].fallback, 'nothing was retried, let alone substituted').toBeUndefined();
  });

  // A documented limit rather than a bug, pinned so it cannot change silently in either direction:
  // This list enumerates top-level steps, so an inner step's substitution is as invisible as the
  // inner step's own output already is. The marker IS written, under the prefixed key.
  it('a substitution inside a nested workflow is not surfaced here — and says so', async () => {
    const journal = new InMemoryJournal();
    const inner = workflow().then(
      retry(step('charge', async () => { throw new Error('down'); }), {
        attempts: 2, fallback: step('viaB', async () => ({ via: 'B' })),
      }),
    );
    const gnl = createGnl({ journal, workflows: { pay: workflow().then(asStep('payment', inner as any)) as any } });

    const res = await gnl.runWorkflow('pay', {}, { runId: 'wf-nested' });
    expect(res.steps[0].output).toEqual({ via: 'B' });
    expect(res.steps[0].fallback, 'the outer step was never retried; the inner one was').toBeUndefined();
    // The record exists — a reader that walks inner keys can find it.
    expect(await journal.get('wf-nested:wf:payment:charge:_fallback')).toMatchObject({ stepId: 'viaB' });
  });

  it('an arbitrary value parked at the marker key is not read as a marker', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, workflows: { pay: workflow().then(step('charge', async () => 'ok')) as any } });
    await gnl.runWorkflow('pay', {}, { runId: 'wf-forge-2' });
    // The journal is a store the host writes to as well; a truthy-only test trusted whatever it found.
    await journal.put('wf-forge-2:wf:charge:_fallback', { attempts: 9, stepId: 'somethingElse' });

    const again = await gnl.runWorkflow('pay', {}, { runId: 'wf-forge-2' });
    expect(again.steps[0].fallback, 'unbranded values are not markers').toBeUndefined();
  });

  it('a fork does not claim a substitution for an output it never copied', async () => {
    const journal = new InMemoryJournal();
    const wf = workflow()
      .then(retry(step('charge', async () => { throw new Error('down'); }), {
        attempts: 2, fallback: step('chargeViaB', async () => ({ via: 'B' })),
      }))
      .then(step('ship', async () => 'shipped'));
    const gnl = createGnl({ journal, workflows: { pay: wf as any } });
    await gnl.runWorkflow('pay', {}, { runId: 'src' });

    // The source crashed between writing the marker and writing the step output — the state a fork
    // can legitimately find. The marker must not be copied on its own: the fork would then run
    // `charge` itself, succeed, and still report that it had fallen back.
    await journal.put('src:wf:charge', undefined as any);
    const orphaned = await journal.get('src:wf:charge');
    expect(orphaned, 'precondition: the output is gone, the marker is not').toBeUndefined();
    expect(await journal.get('src:wf:charge:_fallback')).toBeTruthy();

    await forkWorkflowRun(journal as any, wf as any, 'src', 'ship', 'dst');
    expect(await journal.get('dst:wf:charge:_fallback'), 'a marker must not outlive its subject').toBeUndefined();
  });
});

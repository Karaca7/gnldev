// Three places list `<runId>:wf:*` and turn each key into a step row, and all three filtered exactly
// one name: `_suspend`. Everything else the engine writes alongside a step was rendered as a step the
// workflow never had.
//
// @gnldev/workflow reserves a leading `_` on any path segment for control records and writes retry
// counters as `<id>:attempts`; its own fork sweep skips exactly these. The reader did not. A run whose
// retry fell back to a substitute showed FOUR rows for one step — the output, the attempts counter,
// the `_fallback` marker, and the substitute step — with three of them unexplainable to an operator.
import { describe, it, expect } from 'vitest';
import { isWorkflowStepKey } from '../src/server.js';

describe('the workflow step readers tell steps from bookkeeping', () => {
  it('control records are not steps', () => {
    for (const key of [
      '_suspend',            // written when a step suspends
      '_canceled',           // the durable cancel flag
      '_resume:approval-1',  // a resume payload, keyed by waitId
      'charge:_fallback',    // a retry substitution marker, under the step it describes
      'payment:charge:_fallback', // ...and the same inside a nested workflow
    ]) expect(isWorkflowStepKey(key), key).toBe(false);
  });

  it('retry counters are not steps', () => {
    expect(isWorkflowStepKey('charge:attempts')).toBe(false);
    expect(isWorkflowStepKey('payment:charge:attempts')).toBe(false);
  });

  it('real steps are — including the substitute, which IS one', () => {
    for (const key of [
      'charge',              // a top-level step
      'chargeViaB',          // a fallback step run under its own id
      'payment:checkFunds',  // a step inside a nested workflow
      'items:0:price',       // a foreach branch
    ]) expect(isWorkflowStepKey(key), key).toBe(true);
  });

  // The reserved prefix is about SEGMENTS, so an ordinary id that merely contains an underscore is
  // still a step — refusing those would hide real work.
  it('an underscore inside a name does not make it a control record', () => {
    expect(isWorkflowStepKey('charge_card')).toBe(true);
    expect(isWorkflowStepKey('payment:charge_card')).toBe(true);
    expect(isWorkflowStepKey('attempts')).toBe(true); // a step legitimately named that
  });
});

// The three incident proofs, asserted instead of printed.
//
// These cases reproduce documented double-side-effect incidents and are cited in the README as
// evidence that the guarantee holds. Until now nothing ran them: `pnpm proofs` printed a table for a
// human, `pnpm -r typecheck` proved they compile, and CI did neither. A regression in
// `idempotency: 'args'`, in the tool claim, or in approval replay would have left this example
// quietly wrong while the suite stayed green — the one place where a headline claim had no test
// behind it.
//
// The same functions the demo calls are called here, so the printed table and the assertion can
// never disagree. Assertions are on the NUMBERS rather than on a boolean, so a failure says which
// count moved.
import { describe, it, expect } from 'vitest';
import { runDuplicateToolCallIds } from '../src/duplicate-toolcall-ids.js';
import { runCheckpointResend } from '../src/checkpoint-resend.js';
import { runDoubleApproval } from '../src/double-approval.js';

describe('incident proofs — documented double-side-effect cases', () => {
  it('the model re-planning one call under 5 different toolCallIds charges once', async () => {
    const r = await runDuplicateToolCallIds();
    // The unprotected side must actually reproduce the incident, or the comparison proves nothing.
    expect(r.unprotectedCalls, 'the unprotected path no longer reproduces the incident').toBeGreaterThan(1);
    expect(r.protectedCalls, 'GNL let the side effect run more than once').toBe(1);
    // This case's baseline is runDurable on its defaults, so the row must not be called "no GNL".
    // The counts are the same either way — a call-scoped guard cannot see this pattern — but the
    // label is what the reader takes away, and "no GNL" reads as "installing the library fixes it"
    // when what fixes it is one option. It also puts @gnldev/durable log lines under a row that
    // says GNL is absent, which is the fastest way to make somebody distrust the numbers.
    expect(r.baselineLabel, 'the baseline here IS GNL, on its defaults').not.toContain('no GNL');
    expect(r.baselineLabel).toContain("idempotency: 'call'");
    expect(r.protectedLabel, 'name the option, not the library').toContain("idempotency: 'args'");
  }, 30_000);

  it('a tool call silently resent from a checkpoint after a crash charges once', async () => {
    const r = await runCheckpointResend();
    expect(r.unprotectedCalls).toBeGreaterThan(1);
    expect(r.protectedCalls).toBe(1);
  }, 30_000);

  it('an approval event processed twice charges once', async () => {
    const r = await runDoubleApproval();
    expect(r.unprotectedCalls).toBeGreaterThan(1);
    expect(r.protectedCalls).toBe(1);
  }, 30_000);
});

// Opening a workflow for editing must not turn a failed READ into an empty draft.
//
// `startEdit` caught every failure from `GET /workflows/:name/def` and fell back to
// `{ name, description, steps: [] }`. For a 404 that is right — a code workflow being adopted into the
// managed store has no stored definition yet. For anything else it is a deletion waiting for a click:
// the editor opens showing a workflow with no steps, and Save writes that over the real one.
//
// The 403 is not hypothetical. `GET /workflows/:name/def` refuses an organization-scoped caller whose
// host workflow store has no organization boundary, and this catch swallowed that too — so the user
// saw an unexplained empty workflow instead of a refusal, with Save right there.
import { describe, it, expect } from 'vitest';
import { ApiError } from '../src/api';
import { isMissingDefinition } from '../src/views/Workflows';

describe('isMissingDefinition', () => {
  it('404 → yes, there is genuinely nothing stored', () => {
    expect(isMissingDefinition(new ApiError(404, 'not found'))).toBe(true);
  });

  it.each([
    [403, 'a scope refusal — the definition exists and this caller may not read it'],
    [500, 'a server error — the definition may well exist'],
    [502, 'an upstream failure'],
    [401, 'an expired session'],
  ])('%i → no: %s', (status) => {
    expect(isMissingDefinition(new ApiError(status, 'x'))).toBe(false);
  });

  it('a network failure is not a missing definition either', () => {
    // The case with no status at all: fetch rejected, nothing was read, and the previous shape
    // presented that as an empty workflow.
    expect(isMissingDefinition(new TypeError('Failed to fetch'))).toBe(false);
    expect(isMissingDefinition(undefined)).toBe(false);
  });
});

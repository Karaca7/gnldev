// The error codes the OPERATOR CONSOLE puts on the wire, in one enumerable place.
//
// Same contract as `@gnldev/server`'s `edge-errors.ts` (read its header for the full story): these
// used to be string literals spelled at the point of response, invisible to the docs check — the
// `wire-codes-are-enumerable` test named all four in an exclusion comment and said out loud that
// "this line and four pages are the whole of it" if the admin surface ever joined the
// `docs/errors/` promise. That decision has now been taken, and this file is the line.
//
// Deliberately its own module: `server.ts` here contains a literal NUL byte (an intentional \x00
// delimiter), which makes grep-based tooling treat it as binary and skip it silently — these codes
// stayed invisible to a whole audit sweep for exactly that reason. A tiny import-nothing module is
// readable by everything, including the docs check, which imports the BUILT value.
export const STUDIO_ERROR_CODES = {
  /** 403 — the request's org scope does not cover the object it addresses (multi-org isolation). */
  orgScopeRefused: 'org_scope_refused',
  /** 409 — a concurrent editor saved first; re-read and reapply (policy/pricing editors). */
  versionConflict: 'version_conflict',
  /** 429 — per-caller scan quota or the deployment-wide scan queue is saturated; honour `Retry-After`. */
  deadScanBusy: 'dead_scan_busy',
  /** 503 — repeated dead-letter scans found the store not answering; back off and check the store. */
  deadScanStoreWedged: 'dead_scan_store_wedged',
  /**
   * 504 — one dead-letter scan exceeded its time budget. A FIFTH code: the exclusion comment that
   * used to guard this surface said "four codes", and this one was already on the wire — the exact
   * drift this map exists to end.
   */
  deadScanTimeout: 'dead_scan_timeout',
  /**
   * 409 — the id addresses a row in the run index that no run ever wrote, and purging it would
   * delete a whole keyspace that is not a run's. Not 404: the row really is listed, and telling an
   * operator "not found" about something on their screen is its own kind of lie.
   */
  runNotARun: 'run_not_a_run',
} as const;

export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[keyof typeof STUDIO_ERROR_CODES];

/**
 * HTTP status per console code — the docs-checker's source of truth for this family (same contract
 * as `WIRE_ERROR_STATUS` in @gnldev/durable). The 409→429 drift on `dead_scan_busy` is the measured
 * reason this is data rather than a JSDoc sentence.
 */
export const STUDIO_ERROR_STATUS: Record<string, number> = {
  org_scope_refused: 403,
  version_conflict: 409,
  dead_scan_busy: 429,
  dead_scan_store_wedged: 503,
  dead_scan_timeout: 504,
  run_not_a_run: 409,
};

import { orgScopeOf } from '@gnldev/durable';

/**
 * The scheduler's triggers and the waker's scan live in ONE root log, polled at the root. Handed an
 * organization-scoped journal (`withOrg`), `scheduleWorkflow` filed the trigger under `org:<id>:sched:`,
 * where a root poller never looks — it never fired, and said nothing. A subject view is refused for the
 * same reason, and because a poller must never decide from an end user's filtered view.
 * The queue and the events bus refuse an organization-scoped work store the same way.
 */
export function assertRootJournal(journal: object, fn: string): void {
  const org = orgScopeOf(journal);
  if (org !== undefined) {
    throw new Error(
      `@gnldev/scheduler: ${fn} was handed organization '${org}''s journal — triggers live in the ROOT journal, which the poller reads. ` +
        "Pass the root journal and set the trigger's `orgId` (or `caller: user(id, orgId)`) instead.",
    );
  }
  if ((journal as { __gnlSubjectView?: unknown }).__gnlSubjectView === true) {
    throw new Error(`@gnldev/scheduler: ${fn} was handed an end user's view of the journal — the scheduler reads and writes the raw root journal.`);
  }
}

// The scenarios, as functions the demo and the test BOTH call.
//
// Taken from examples/incident-proofs: the printed table and the assertions can never disagree, because
// there is one implementation. A demo that prints its own numbers and a test that computes different ones
// is how a README ends up citing something that stopped being true.
//
// Every scenario returns the numbers, not a verdict. The test asserts on them, the table prints them, and
// a failure says which number moved.
import { purgeResource } from '@gnldev/durable';
import { connect, startServer, type RunningServer } from './server.js';

export interface Scenario {
  id: string;
  question: string;
  /** What a caller without the right to something actually received. */
  outcome: string;
  detail: string;
}

/** ① An unauthenticated request never reaches GNL. */
export async function anonymousIsStopped(s: RunningServer): Promise<Scenario> {
  const res = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return {
    id: 'anonymous',
    question: '① a request with no token',
    outcome: `HTTP ${res.status}`,
    detail: `WWW-Authenticate: ${res.headers.get('www-authenticate') ?? '(absent)'} — refused by YOUR middleware, before any MCP handler ran`,
  };
}

/** ③ The list a caller is shown is the list it may use. */
export async function listIsFiltered(s: RunningServer): Promise<Scenario & { full: string[]; reduced: string[] }> {
  const full = await connect(s.url, 'acme-token');
  const reduced = await connect(s.url, 'reporting-token');
  const a = (await full.listTools()).tools.map((t) => t.name).sort();
  const b = (await reduced.listTools()).tools.map((t) => t.name).sort();
  await full.close();
  await reduced.close();
  return {
    id: 'list-filtered',
    question: '③ tools/list, two tokens with different scopes',
    outcome: `${a.length} vs ${b.length} tools`,
    detail: `acme sees [${a.join(', ')}]; the reporting integration sees [${b.join(', ')}]`,
    full: a,
    reduced: b,
  };
}

/** ③ And the call door does not contradict the list by confirming the tool exists. */
export async function forbiddenLooksMissing(s: RunningServer): Promise<Scenario & { same: boolean }> {
  const c = await connect(s.url, 'reporting-token');
  const forbidden = await c.callTool({ name: 'refund', arguments: { invoiceId: 'inv-1' } }).then(() => 'resolved', (e: Error) => e.message);
  const invented = await c.callTool({ name: 'not_a_tool', arguments: {} }).then(() => 'resolved', (e: Error) => e.message);
  await c.close();
  // Compare with the tool name removed: what must match is the SHAPE of the answer, not the name in it.
  const shape = (m: string) => String(m).replace(/no such tool: \S+/, 'no such tool: <name>');
  return {
    id: 'forbidden-vs-missing',
    question: '③ a tool the scope omits, vs a name that does not exist',
    outcome: shape(forbidden) === shape(invented) ? 'identical' : 'DISTINGUISHABLE',
    detail: `both answer: ${shape(forbidden)}`,
    same: shape(forbidden) === shape(invented),
  };
}

/** ④ The tool can tell whose invoice it is — the check no framework layer can make for you. */
export async function otherTenantIsRefused(s: RunningServer): Promise<Scenario & { own: unknown; theirs: unknown }> {
  const c = await connect(s.url, 'acme-token');
  const own: any = await c.callTool({ name: 'read_invoice', arguments: { invoiceId: 'inv-1' }, _meta: { idempotencyKey: 'own' } });
  const theirs: any = await c.callTool({ name: 'read_invoice', arguments: { invoiceId: 'inv-2' }, _meta: { idempotencyKey: 'theirs' } });
  await c.close();
  const text = (r: any) => JSON.stringify(r?.content?.[0]?.text ?? r);
  return {
    id: 'cross-tenant',
    question: '④ acme asks for globex’s invoice',
    outcome: text(theirs).includes('not your invoice') ? 'refused by the tool' : 'LEAKED',
    detail: `own invoice: ${text(own).includes('TR44') ? 'returned' : 'unexpected'}; the other tenant’s: ${text(theirs).slice(0, 60)}`,
    own,
    theirs,
  };
}

/** The guarantee: one key, one side effect — including when two callers send it at the same moment. */
export async function concurrentRefundChargesOnce(
  s: RunningServer,
): Promise<Scenario & { effects: number; succeeded: number; retryable: number; thrown: number }> {
  const before = s.effects.filter((e) => e.startsWith('refund')).length;
  const c = await connect(s.url, 'acme-token');
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      c
        .callTool({ name: 'refund', arguments: { invoiceId: 'inv-1' }, _meta: { idempotencyKey: 'refund-inv-1' } })
        .then((r: any) => r, (e: Error) => ({ thrown: e.message })),
    ),
  );
  await c.close();
  const effects = s.effects.filter((e) => e.startsWith('refund')).length - before;
  const body = (r: any) => JSON.stringify(r?.content?.[0]?.text ?? r);
  const succeeded = results.filter((r: any) => body(r).includes('refunded')).length;
  const retryable = results.filter((r: any) => body(r).includes('run_busy')).length;
  const thrown = results.filter((r: any) => (r as any).thrown).length;
  return {
    id: 'concurrent',
    question: '5 refunds of one invoice, sent at the same moment',
    outcome: `${effects} side effect(s)`,
    detail: `${succeeded} got the result, ${retryable} were told to retry the same key, ${thrown} escaped as an exception`,
    effects,
    succeeded,
    retryable,
    thrown,
  };
}

/** The message the losers get is advice, and the advice works. */
export async function retryCollectsTheResult(s: RunningServer): Promise<Scenario & { extraEffects: number; refunded: boolean }> {
  const before = s.effects.filter((e) => e.includes('inv-1')).length;
  const c = await connect(s.url, 'acme-token');
  const again: any = await c.callTool({ name: 'refund', arguments: { invoiceId: 'inv-1' }, _meta: { idempotencyKey: 'refund-inv-1' } });
  await c.close();
  const extraEffects = s.effects.filter((e) => e.includes('inv-1')).length - before;
  const body = JSON.stringify(again?.content?.[0]?.text ?? again);
  return {
    id: 'retry',
    question: 'retrying the same key after losing the race',
    outcome: extraEffects === 0 ? 'result returned, nothing re-ran' : `RE-RAN ${extraEffects} time(s)`,
    detail: `response contains "refunded": ${body.includes('refunded')}`,
    extraEffects,
    refunded: body.includes('refunded'),
  };
}

/** The journal knows whose runs these are, so a deletion request can find them. */
export async function deletionRequestFindsTheRuns(
  s: RunningServer,
): Promise<Scenario & { owned: number; deleted: number; leftForSubject: number; otherTenantRuns: number }> {
  // Give the OTHER tenant a run first. Without one, "the other tenant is untouched" is a claim about an
  // empty set — it would read as reassurance and assert nothing, and the demo printed exactly that
  // ("globex still has 0") before this line existed.
  const globex = await connect(s.url, 'globex-token');
  await globex.callTool({ name: 'read_invoice', arguments: { invoiceId: 'inv-2' }, _meta: { idempotencyKey: 'globex-own' } });
  await globex.close();

  const runs = await (s.journal as any).listRuns();
  const owned = runs.filter((r: any) => r.resourceId === 'acme-ltd').length;
  const deleted = await purgeResource(s.journal, 'acme-ltd');
  const after = await (s.journal as any).listRuns();
  return {
    id: 'purge',
    question: 'acme asks for its data to be deleted',
    outcome: `${deleted} record(s) removed`,
    detail: `${owned} run(s) were attributed to acme; ${after.filter((r: any) => r.resourceId === 'acme-ltd').length} left; globex still has ${after.filter((r: any) => r.resourceId === 'globex-inc').length}`,
    owned,
    deleted,
    leftForSubject: after.filter((r: any) => r.resourceId === 'acme-ltd').length,
    otherTenantRuns: after.filter((r: any) => r.resourceId === 'globex-inc').length,
  };
}

/**
 * Sessions are dropped — and a close hook alone is not what drops most of them.
 *
 * Measured against this server: `client.close()` left the session in place (1 → 1); only
 * `terminateSession()`, a separate call, made the server drop it (2 → 1). So an orderly goodbye is opt-in
 * on the client, and a client that merely disconnects or crashes never sends one. The idle sweep is what
 * covers those, and this scenario exercises BOTH paths.
 */
export async function sessionsDoNotLeak(
  s: RunningServer,
): Promise<Scenario & { afterOpen: number; afterOrderly: number; afterIdleSweep: number }> {
  // Counted as a DELTA. Reporting the server's total would fold in every session the earlier scenarios
  // opened, so the row would say "6 clients" above a number that is not 6 — a table nobody can check.
  const base = s.sessionCount();
  const opened = await Promise.all(Array.from({ length: 6 }, () => connect(s.url, 'globex-token')));
  for (const c of opened) await c.listTools();
  const afterOpen = s.sessionCount() - base;

  // Half say goodbye properly. The DELETE is `terminateSession`, not `close`.
  for (const c of opened.slice(0, 3)) {
    await (c as unknown as { transport?: { terminateSession?: () => Promise<void> } }).transport?.terminateSession?.();
    await c.close();
  }
  await new Promise((r) => setTimeout(r, 50));
  const afterOrderly = s.sessionCount() - base;

  // The other half just disappear — the ordinary case, and the one a close hook cannot see.
  for (const c of opened.slice(3)) await c.close();
  // The sweep is global — it drops every idle session, including the earlier scenarios'. That is the
  // point of it, so the count it returns is reported as-is and the delta is what this row claims.
  s.sweepIdleSessions(Date.now() + 10 * 60_000);
  const afterIdleSweep = s.sessionCount();

  return {
    id: 'sessions',
    question: '6 clients connect; 3 say goodbye, 3 vanish',
    outcome: `${afterOpen} → ${afterOrderly} of this row's own; ${afterIdleSweep} left in total`,
    detail:
      `the orderly 3 left on DELETE; the silent 3 needed the idle sweep, which also cleared the earlier ` +
      `rows' sessions. client.close() alone does NOT end a server session — measured.`,
    afterOpen,
    afterOrderly,
    afterIdleSweep,
  };
}

/** Every scenario, in order, against one server. Returned rather than printed, so the test reads the same rows. */
export async function runAll(): Promise<{ rows: Scenario[]; server: RunningServer }> {
  const server = await startServer();
  const rows: Scenario[] = [];
  rows.push(await anonymousIsStopped(server));
  rows.push(await listIsFiltered(server));
  rows.push(await forbiddenLooksMissing(server));
  rows.push(await otherTenantIsRefused(server));
  rows.push(await concurrentRefundChargesOnce(server));
  rows.push(await retryCollectsTheResult(server));
  rows.push(await sessionsDoNotLeak(server));
  // Purge last: it deletes the records the earlier rows created.
  rows.push(await deletionRequestFindsTheRuns(server));
  return { rows, server };
}

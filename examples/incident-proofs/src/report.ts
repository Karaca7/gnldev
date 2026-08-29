// Shared reporting for the 3 incident proofs. No dependency — just formatting.
//
// Measuring and PRINTING are separate on purpose. Each case used to end in `return printCase({...})`,
// so the only way to run a proof was to print it, and the only thing a caller got back was a boolean.
// That made the proofs unusable as tests — and these three cases are the evidence behind a headline
// claim, so "nothing runs them" was the gap worth closing. Now a case returns its NUMBERS,
// `index.ts` prints them, and test/incident-proofs.test.ts asserts on them. One measurement, two
// readers.

export interface CaseResult {
  id: string; // e.g. "duplicate-toolcall-ids"
  title: string;
  unprotectedCalls: number;
  protectedCalls: number;
}

/** Identity, but it names the shape at each call site and keeps the cases free of `printCase`. */
export function caseResult(r: CaseResult): CaseResult {
  return r;
}

/** The property every case proves: the unprotected path repeats the side effect, GNL runs it once. */
export function blocked(r: CaseResult): boolean {
  return r.protectedCalls === 1 && r.unprotectedCalls > r.protectedCalls;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

export function printCase(r: CaseResult): boolean {
  const ok = blocked(r);
  console.log('');
  console.log(`=== ${r.id} — ${r.title} ===`);
  const col1 = 'scenario';
  const col2 = 'side-effect count';
  const w1 = Math.max(col1.length, 'unprotected (no GNL)'.length);
  const w2 = Math.max(col2.length, 'N times'.length);
  const line = (a: string, b: string) => `| ${pad(a, w1)} | ${pad(b, w2)} |`;
  const sep = `+-${'-'.repeat(w1)}-+-${'-'.repeat(w2)}-+`;
  console.log(sep);
  console.log(line(col1, col2));
  console.log(sep);
  console.log(line('unprotected (no GNL)', `${r.unprotectedCalls} times`));
  console.log(line('with GNL', `${r.protectedCalls} times`));
  console.log(sep);
  console.log(ok ? '✅ GNL blocked it — side effect ran 1 time' : '❌ UNEXPECTED RESULT');
  return ok;
}

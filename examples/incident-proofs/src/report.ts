// Shared console-table printer for the 3 incident proofs. No dependency — just formatting.

export interface CaseResult {
  id: string; // e.g. "duplicate-toolcall-ids"
  title: string;
  unprotectedCalls: number;
  protectedCalls: number;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

export function printCase(r: CaseResult): boolean {
  const ok = r.protectedCalls === 1 && r.unprotectedCalls > r.protectedCalls;
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

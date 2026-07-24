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
  const col1 = 'senaryo';
  const col2 = 'yan-etki sayısı';
  const w1 = Math.max(col1.length, 'korumasız (GNL yok)'.length);
  const w2 = Math.max(col2.length, 'N kez'.length);
  const line = (a: string, b: string) => `| ${pad(a, w1)} | ${pad(b, w2)} |`;
  const sep = `+-${'-'.repeat(w1)}-+-${'-'.repeat(w2)}-+`;
  console.log(sep);
  console.log(line(col1, col2));
  console.log(sep);
  console.log(line('korumasız (GNL yok)', `${r.unprotectedCalls} kez`));
  console.log(line('GNL ile', `${r.protectedCalls} kez`));
  console.log(sep);
  console.log(ok ? '✅ GNL engelledi — yan-etki 1 kez' : '❌ BEKLENMEYEN SONUÇ');
  return ok;
}

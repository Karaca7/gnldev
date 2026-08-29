// Run:  pnpm proofs   (no API key needed — deterministic mock model)
//
// Reproduces 3 DOCUMENTED double-side-effect incidents and proves GNL blocks each one: for every case
// this prints "unprotected: N times / with GNL: 1 time" from a REAL, running `runDurable` call — not a claim.
import { runDuplicateToolCallIds } from './duplicate-toolcall-ids.js';
import { runCheckpointResend } from './checkpoint-resend.js';
import { runDoubleApproval } from './double-approval.js';
import { printCase } from './report.js';

console.log('GNL incident-proofs — 3 documented double-side-effect cases, proven from code\n');

// The cases MEASURE; this file prints. The same three functions are asserted on by
// test/incident-proofs.test.ts, so what CI checks and what this prints cannot drift apart.
const results = [
  await runDuplicateToolCallIds(),
  await runCheckpointResend(),
  await runDoubleApproval(),
].map(printCase);

console.log('');
console.log(`RESULT: ${results.filter(Boolean).length}/${results.length} cases blocked by GNL.`);
if (!results.every(Boolean)) process.exitCode = 1;

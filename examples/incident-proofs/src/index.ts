// Run:  pnpm proofs   (no API key needed — deterministic mock model)
//
// Reproduces 3 DOCUMENTED double-side-effect incidents and proves GNL blocks each one: for every case
// this prints "korumasız: N kez / GNL ile: 1 kez" from a REAL, running `runDurable` call — not a claim.
import { runDuplicateToolCallIds } from './duplicate-toolcall-ids.js';
import { runCheckpointResend } from './checkpoint-resend.js';
import { runDoubleApproval } from './double-approval.js';

console.log('GNL incident-proofs — 3 belgelenmiş çift-yan-etki vakası, koddan kanıtlı\n');

const results = [
  await runDuplicateToolCallIds(),
  await runCheckpointResend(),
  await runDoubleApproval(),
];

console.log('');
console.log(`SONUÇ: ${results.filter(Boolean).length}/${results.length} vaka GNL tarafından engellendi.`);
if (!results.every(Boolean)) process.exitCode = 1;

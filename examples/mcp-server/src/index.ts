// Runnable: `pnpm demo` from this directory.
//
// Stands up a real HTTP MCP server, connects real MCP clients with real Bearer tokens, and prints what
// each caller actually got. The same functions are asserted in test/, so this table cannot drift from
// what the suite checks.
import { runAll } from './scenarios.js';

const { rows, server } = await runAll();

const w = Math.max(...rows.map((r) => r.question.length));
console.log('\n  A multi-tenant MCP server over real HTTP\n');
for (const r of rows) {
  console.log(`  ${r.question.padEnd(w)}   ${r.outcome}`);
  console.log(`  ${' '.repeat(w)}   ${r.detail}\n`);
}
console.log('  ① is your middleware. ② identity  ③ allowTool  ④ the tool itself  ⑤ rateLimit');
console.log('  See README.md for why ④ cannot be delegated to a framework.\n');

await server.close();

// Two requests, SAME runId, sent at the same moment. What happens to each?
import { InMemoryStorage, createGnl } from '@gnldev/durable';
import { MockLanguageModelV4 } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';

const usage = { inputTokens:{total:1,noCache:1,cacheRead:undefined,cacheWrite:undefined},
                outputTokens:{total:1,text:1,reasoning:undefined} };
const finish = (r: string) => ({ unified: r, raw: r });

let executions = 0;
const slowTool = tool({
  description: 'Does the real work. Slow, so the two requests genuinely overlap.',
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => {
    executions++;
    await new Promise((r) => setTimeout(r, 400));   // long enough to overlap
    return { did: what, executionNo: executions };
  },
});

const mkModel = (who: string) => new MockLanguageModelV4({
  doGenerate: [
    { content: [{ type:'tool-call', toolCallId:'c1', toolName:'slowTool', input: JSON.stringify({ what: who }) }],
      finishReason: finish('tool-calls'), usage, warnings: [] },
    { content: [{ type:'text', text: `done for ${who}` }], finishReason: finish('stop'), usage, warnings: [] },
  ] as any,
}) as any;

const storage = new InMemoryStorage();
const gnl = createGnl({ storage, agents: {
  a: { model: mkModel('ALICE'), tools: { slowTool }, system: 's', maxSteps: 3 },
  b: { model: mkModel('BOB'),   tools: { slowTool }, system: 's', maxSteps: 3 },
}});

const RUN = 'order:12345';
console.log('Ayni anda, ayni runId ile iki istek:\n');

const [ra, rb] = await Promise.allSettled([
  gnl.run('a', { runId: RUN, prompt: 'alice is buying' }),
  gnl.run('b', { runId: RUN, prompt: 'bob is buying' }),
]);

const show = (label: string, r: PromiseSettledResult<any>) => {
  if (r.status === 'fulfilled') console.log(`${label}: OK    → "${r.value.text}"`);
  else console.log(`${label}: HATA  → ${String(r.reason?.name ?? '')} ${String(r.reason?.message ?? r.reason).slice(0,110)}`);
};
show('A', ra);
show('B', rb);
console.log('\nARACIN GERCEKTE CALISMA SAYISI:', executions);

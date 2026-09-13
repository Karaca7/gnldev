// A deterministic on-call model — NO API KEY. It plans the same sequence a real one would:
//
//   1. read the runbook for this alert          (searchRunbook)
//   2. pull the numbers the runbook asks for    (getMetric)
//   3. read the failing service's log           (readLog — the one that carries secrets)
//   4. act, if the runbook says to              (restartService — behind an approval)
//   5. write the diagnosis
//
// Deterministic on purpose: this example is also the tutorial, and a tutorial whose output changes
// between runs cannot teach what a durable run guarantees. A real provider is wired in the same place
// (`buildModel`) when NVIDIA_API_KEY / OPENAI_API_KEY is present.
const usage = { inputTokens: 12, outputTokens: 6, totalTokens: 18 };

export function lastUserText(prompt: any[]): string {
  for (let i = (prompt?.length ?? 0) - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ');
  }
  return '';
}

/** Tool results that arrived AFTER the last user message — i.e. how far into THIS turn we are. */
function stepsThisTurn(prompt: any[]): number {
  let lastUser = -1;
  for (let i = 0; i < (prompt?.length ?? 0); i++) if (prompt[i]?.role === 'user') lastUser = i;
  return (prompt ?? []).slice(lastUser + 1).filter((m: any) => m?.role === 'tool').length;
}

/** The service an alert is about, from its text. Falls back so a free-text question still works. */
export function serviceOf(text: string): string {
  const m = /\b(checkout|search|billing|gateway|pg-primary)\b/i.exec(text);
  return m ? m[1].toLowerCase() : 'checkout';
}

/**
 * Whether this alert is one the runbook says to act on, or one to only report.
 *
 * Deliberately a property of the ALERT rather than a coin flip: the tutorial needs a run that stops
 * for a human and a run that does not, and the reader has to be able to tell which they will get.
 */
export function needsRestart(text: string): boolean {
  return /\b(memory leak|oom|out of memory|saturat)/i.test(text);
}

const call = (id: string, name: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
  finishReason: 'tool-calls' as const,
  usage,
  warnings: [] as any[],
});

const say = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: 'stop' as const,
  usage,
  warnings: [] as any[],
});

/** The system text, so the mock can tell WHICH agent it is being asked to be. */
function systemText(prompt: any[]): string {
  const s = (prompt ?? []).find((m: any) => m?.role === 'system');
  return typeof s?.content === 'string' ? s.content : '';
}

/** The ONE place the mock decides what to do next. Both doGenerate and doStream read it. */
function plan(prompt: any[]) {
  const alert = lastUserText(prompt);
  const svc = serviceOf(alert);

  // The database specialist is a DIFFERENT agent with a different toolset (see specialist.ts), so the
  // mock plans a different sequence for it: consult the MCP-provided tool, then answer with the number
  // it found. Without this branch the specialist would answer from its system prompt alone and its MCP
  // Tools would be wired but never called — a demonstration of nothing.
  if (systemText(prompt).includes('database specialist')) {
    const tag = svc + '-sp';
    return stepsThisTurn(prompt) === 0
      ? call(`sq-${tag}`, 'db_slowQueries', { service: svc })
      : say(
          `Second opinion on ${svc}: the pool is saturated by a slow per-customer order lookup ` +
          `(mean 1840ms over 12400 calls). This is a missing index, not a memory problem — a ` +
          `restart will not help.`,
        );
  }
  // The ids are derived from the alert, not from a counter: a resumed run must plan the SAME
  // toolCallId, or the journal cannot recognise the step it already ran.
  const tag = svc + '-' + (alert.length % 997);
  switch (stepsThisTurn(prompt)) {
    case 0: return call(`rb-${tag}`, 'searchRunbook', { query: alert.slice(0, 120) });
    case 1: return call(`mx-${tag}`, 'getMetric', { service: svc, metric: 'memory_rss_mb' });
    case 2: return call(`lg-${tag}`, 'readLog', { service: svc, lines: 20 });
    case 3:
      return needsRestart(alert)
        ? call(`rs-${tag}`, 'restartService', { service: svc, reason: 'runbook: memory saturation' })
        : say(`Diagnosis for ${svc}: within runbook limits, no action taken. Watch for 30m.`);
    default:
      return say(`Diagnosis for ${svc}: runbook applied, service restarted, watching for 30m.`);
  }
}

const mockModel: any = {
  specificationVersion: 'v2',
  provider: 'gnl-demo',
  modelId: 'oncall-mock',
  supportedUrls: {},
  doGenerate: async ({ prompt }: any) => plan(prompt),
  /**
   * The SAME decisions as doGenerate, delivered as chunks.
   *
   * Written out rather than left to throw because the chat route in server.ts streams, and shipping a
   * route whose only model cannot feed it is shipping a page that 500s. It also keeps the two paths
   * honest with each other: both call `plan()`, so the streamed run and the one-shot run cannot drift
   * into telling the reader different stories about what the agent does.
   */
  doStream: async ({ prompt }: any) => {
    const p = plan(prompt);
    const chunks: any[] =
      p.finishReason === 'tool-calls'
        ? [{ type: 'stream-start', warnings: [] }, { ...(p.content[0] as any), type: 'tool-call' }]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: (p.content[0] as any).text },
            { type: 'text-end', id: '1' },
          ];
    chunks.push({ type: 'finish', finishReason: p.finishReason, usage });
    return {
      stream: new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(ch);
          c.close();
        },
      }),
    };
  },
};

export const HAS_REAL_MODEL = !!process.env.NVIDIA_API_KEY || !!process.env.OPENAI_API_KEY;

/** The mock unless a key is present. Same shape either way, so nothing else in this app changes. */
export async function buildModel(): Promise<any> {
  if (!HAS_REAL_MODEL) return mockModel;
  const { createOpenAI } = await import('@ai-sdk/openai');
  if (process.env.NVIDIA_API_KEY) {
    const nvidia = createOpenAI({
      baseURL: process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      apiKey: process.env.NVIDIA_API_KEY,
    });
    // No default model id is hard-coded here on purpose: provider catalogues change, and a constant
    // that names a retired model turns a working example into a 410 for everyone who clones it.
    const id = process.env.NVIDIA_MODEL;
    if (!id) throw new Error('oncall-triage: set NVIDIA_MODEL to a model your key can call (GET /v1/models lists them)');
    return nvidia.chat(id);
  }
  const oa = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return oa.chat(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
}

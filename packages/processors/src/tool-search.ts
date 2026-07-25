// toolSearch — semantic tool-search parity with the common "tool-search processor"/skills pattern.
// With large tool sets (dozens/hundreds of tools), showing all of them to the model bloats the
// context and lowers selection quality; this processor selects the most relevant topK tools by
// EMBEDDING similarity to the last user message, and runs the model with only those.
//
// Determinism: selection is non-deterministic (embed call) → the selected TOOL NAMES are journaled
// via `ctx.step` — on resume/replay, embed is NOT CALLED AGAIN, the model sees the same tool subset.
// Safe-side behavior: does NOT NARROW when there is no query, or when the tool count is already
// within topK.
import type { Processor } from '@gnldev/durable';

export interface ToolSearchOptions {
  /** text → embedding (wires to the AI SDK `embed`; faked in tests). */
  embed: (text: string) => Promise<number[]>;
  /** Number of most relevant tools to show the model (excluding always). Default 8. */
  topK?: number;
  /** Tools always included (not scored; not counted toward topK). */
  always?: string[];
  /** Tools below this similarity are eliminated even if they'd fit within topK (0..1). */
  minScore?: number;
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Query signal: text of the last user message; falls back to a string prompt. */
function queryOf(input?: { messages?: any[]; prompt?: unknown }): string | undefined {
  for (let i = (input?.messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = input!.messages![i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ');
      if (t) return t;
    }
  }
  return typeof input?.prompt === 'string' ? input.prompt : undefined;
}

/**
 * Semantic tool-search processor (processTools). Selected names are journaled (`proc:tool-search`)
 * → exactly-once selection; embed does not run on resume. Tool names from the journaled selection
 * that no longer exist are silently skipped (replay doesn't break even if the tool set changes).
 */
export function toolSearch(opts: ToolSearchOptions): Processor {
  const topK = opts.topK ?? 8;
  if (topK < 1) throw new Error('@gnldev/processors toolSearch: topK must be >= 1');
  const always = new Set(opts.always ?? []);
  return {
    name: 'tool-search',
    async processTools(tools, ctx) {
      const names = Object.keys(tools);
      const searchable = names.filter((n) => !always.has(n));
      if (searchable.length <= topK) return tools; // no need to narrow
      const query = queryOf(ctx.input);
      if (!query) return tools; // no query signal → safe side: show all

      const selected = await ctx.step<string[]>('tool-search', async () => {
        const qv = await opts.embed(query);
        const scored = await Promise.all(
          searchable.map(async (n) => {
            const desc = `${n}: ${String(tools[n]?.description ?? '')}`;
            return { n, s: cosine(qv, await opts.embed(desc)) };
          }),
        );
        return scored
          .filter((x) => (opts.minScore == null ? true : x.s >= opts.minScore))
          .sort((a, b) => b.s - a.s || (a.n < b.n ? -1 : 1)) // stable by name on equal score
          .slice(0, topK)
          .map((x) => x.n);
      });

      const out: Record<string, any> = {};
      for (const n of names) {
        if (always.has(n) || selected.includes(n)) out[n] = tools[n];
      }
      return out;
    },
  };
}

// MessageList — tag messages by their source, dedupe, keep them ordered, hand clean ones to the model.
// (A simplified take on the common "message list" pattern — focused on AI SDK v5; v4/v6 multi-format conversion is SKIP in v1.)
export type MessageSource = 'memory' | 'input' | 'response' | 'system' | 'user' | 'context';

export interface TaggedMessage {
  role: string;
  content: any;
  id?: string;
  __source: MessageSource;
  [k: string]: unknown;
}

export class MessageList {
  private items: TaggedMessage[] = [];

  /** Add message(s) tagged with a source. */
  add(messages: any | any[], source: MessageSource): this {
    const arr = Array.isArray(messages) ? messages : messages == null ? [] : [messages];
    for (const m of arr) this.items.push({ ...m, __source: source });
    return this;
  }

  private dedupKey(m: TaggedMessage): string {
    return m.id ?? `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
  }

  /** Deduplicated (by id if present, otherwise by role+content), in insertion order. */
  get(): TaggedMessage[] {
    const seen = new Set<string>();
    const out: TaggedMessage[] = [];
    for (const m of this.items) {
      const k = this.dedupKey(m);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
    return out;
  }

  /** Messages coming from a specific source (memory/input/response...). */
  bySource(source: MessageSource): TaggedMessage[] {
    return this.get().filter((m) => m.__source === source);
  }

  /** Clean messages ready for the AI SDK (with the `__source` tag stripped). */
  toModelMessages(): any[] {
    return this.get().map(({ __source, ...m }) => m);
  }
}

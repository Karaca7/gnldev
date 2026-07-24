// Greenfield: thread/message/WM/OM now live on the MemoryStore + RunJournal ports (NOT journal keys).
// This file holds only pure helpers.

/** Extract the text to embed from a message (string content or text parts). */
export function messageText(m: any): string | undefined {
  if (typeof m?.content === 'string') return m.content || undefined;
  if (Array.isArray(m?.content)) {
    const t = m.content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ');
    return t || undefined;
  }
  return undefined;
}

/** Whether the vector is not zero-norm (for cosine). */
export const hasNorm = (v?: number[]): v is number[] => !!v && v.some((x) => x !== 0);

/** text → embedding function (wired to AI SDK embed or a fake). */
export type Embed = (text: string) => Promise<number[]>;

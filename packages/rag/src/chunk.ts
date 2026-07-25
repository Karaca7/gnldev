// Chunking helpers — the common `document.chunk()` shape (code-first, class-free).
// `chunkText` splits raw text into chunks; `chunkDocuments` splits VectorDocs and produces a new
// VectorDoc list ready for `indexDocuments` (id: `<source>#<i>`, metadata inherited + source trail).
// Strategies:
//   - 'recursive' (default): splits preferring paragraph → line → sentence → word boundaries
//     (the general-purpose strategy with the highest semantic coherence).
//   - 'markdown': splits by heading hierarchy; adds a `heading` breadcrumb metadata to each chunk
//     (for context display during retrieval), large text within a section is split recursively.
//   - 'character': fixed window (fastest; when boundary quality doesn't matter).
import type { VectorDoc } from './vector-store.js';

export interface ChunkOptions {
  /** Target chunk size (characters). Default 1200. */
  size?: number;
  /** Overlap between consecutive chunks (characters, must be smaller than size). Default 120. */
  overlap?: number;
  strategy?: 'recursive' | 'markdown' | 'character';
}

/** Chunk + (in markdown) heading trail. */
export interface Chunk {
  text: string;
  /** heading breadcrumb of the section in the markdown strategy (e.g. "Setup > Docker"). */
  heading?: string;
}

const DEFAULT_SIZE = 1200;
const DEFAULT_OVERLAP = 120;

function resolveOpts(opts?: ChunkOptions): { size: number; overlap: number; strategy: NonNullable<ChunkOptions['strategy']> } {
  const size = opts?.size ?? DEFAULT_SIZE;
  const overlap = opts?.overlap ?? Math.min(DEFAULT_OVERLAP, Math.floor(size / 4));
  if (size < 1) throw new Error('@gnldev/rag chunk: size must be >= 1');
  if (overlap < 0 || overlap >= size) throw new Error('@gnldev/rag chunk: 0 <= overlap < size must hold');
  return { size, overlap, strategy: opts?.strategy ?? 'recursive' };
}

/** Separator priority list: paragraph → line → sentence → word. Last resort: hard cut. */
const SEPARATORS = ['\n\n', '\n', '. ', ' '];

/** GREEDILY merges pieces up to the target size (preserving the separator); a piece that alone stays over size passes through as-is. */
function mergeGreedy(pieces: string[], sep: string, size: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    const joined = cur === '' ? p : cur + sep + p;
    if (joined.length <= size || cur === '') cur = joined;
    else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** Recursive split: start from the coarsest separator; any unit exceeding size is re-split with the next separator. */
function splitRecursive(text: string, size: number, sepIdx = 0): string[] {
  if (text.length <= size) return text.trim() === '' ? [] : [text];
  if (sepIdx >= SEPARATORS.length) {
    const out: string[] = []; // no natural boundary left → hard cut
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }
  const sep = SEPARATORS[sepIdx]!;
  const pieces = text.split(sep).filter((p) => p.trim() !== '');
  if (pieces.length <= 1) return splitRecursive(text, size, sepIdx + 1);
  const merged = mergeGreedy(pieces, sep, size);
  return merged.flatMap((m) => (m.length <= size ? [m] : splitRecursive(m, size, sepIdx + 1)));
}

/** Apply overlap to consecutive chunks: the tail of the previous chunk is prepended to each one (context continuity). */
function applyOverlap(chunks: string[], overlap: number): string[] {
  if (overlap === 0 || chunks.length <= 1) return chunks;
  return chunks.map((c, i) => (i === 0 ? c : chunks[i - 1]!.slice(-overlap) + c));
}

/** Section the markdown by heading hierarchy: each section = breadcrumb + body. */
function splitMarkdownSections(text: string): { heading?: string; body: string }[] {
  const lines = text.split('\n');
  const sections: { heading?: string; body: string }[] = [];
  const crumbs: { level: number; title: string }[] = [];
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n');
    if (body.trim() !== '') {
      const heading = crumbs.map((c) => c.title).join(' > ') || undefined;
      sections.push({ heading, body });
    }
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      while (crumbs.length && crumbs[crumbs.length - 1]!.level >= level) crumbs.pop();
      crumbs.push({ level, title: m[2]!.trim() });
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** Split raw text into chunks (strategy + size + overlap). */
export function chunkText(text: string, opts?: ChunkOptions): Chunk[] {
  const { size, overlap, strategy } = resolveOpts(opts);
  if (text.trim() === '') return [];
  if (strategy === 'character') {
    const out: string[] = [];
    const stride = size - overlap;
    for (let i = 0; i < text.length; i += stride) {
      out.push(text.slice(i, i + size));
      if (i + size >= text.length) break;
    }
    return out.map((t) => ({ text: t }));
  }
  if (strategy === 'markdown') {
    return splitMarkdownSections(text).flatMap(({ heading, body }) =>
      applyOverlap(splitRecursive(body.trim(), size), overlap).map((t) => ({ text: t, ...(heading ? { heading } : {}) })),
    );
  }
  return applyOverlap(splitRecursive(text, size), overlap).map((t) => ({ text: t }));
}

/**
 * Split documents → VectorDoc list ready for `indexDocuments`. Chunk id is `<docId>#<i>`
 * (deterministic → re-indexing upserts to the same ids, no duplicate records); metadata
 * is inherited + a `{ source, chunk }` trail is added (and a `heading` breadcrumb in markdown).
 */
export function chunkDocuments(docs: VectorDoc[], opts?: ChunkOptions): VectorDoc[] {
  const out: VectorDoc[] = [];
  for (const doc of docs) {
    const chunks = chunkText(doc.text, opts);
    if (chunks.length <= 1) {
      out.push(doc); // not split → original id/metadata as-is (no pointless #0 derivation)
      continue;
    }
    chunks.forEach((c, i) => {
      out.push({
        id: `${doc.id}#${i}`,
        text: c.text,
        metadata: { ...doc.metadata, source: doc.id, chunk: i, ...(c.heading ? { heading: c.heading } : {}) },
      });
    });
  }
  return out;
}

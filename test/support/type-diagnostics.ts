// Compiles TypeScript snippets as if they were files in a package's test directory, against the
// packages' published declarations (dist), and returns each snippet's diagnostics.
//
// vitest does not type-check test files: an `expectTypeOf` or a `// @ts-expect-error` in a test passes
// at runtime whatever the types say. A type contract is only held if the compiler runs, which is what
// this does. packages/server/test/engine-caller-shape.test.ts was the first test of this kind.
//
// All snippets of one call share ONE program, because creating a program is the slow part (seconds);
// a file of twenty cases would otherwise pay it twenty times.
import ts from 'typescript';
import { join } from 'node:path';

export interface TypeDiagnostic {
  code: number;
  message: string;
}

/**
 * `dir` is the directory the snippets pretend to live in — pass the test file's own directory
 * (`__dirname`), so `@gnldev/*` imports resolve through that package's dependencies exactly as a
 * user's code would. Returns the diagnostics of each snippet, keyed like `snippets`.
 */
export function typeDiagnostics(dir: string, snippets: Record<string, string>): Record<string, TypeDiagnostic[]> {
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const files = new Map(Object.entries(snippets).map(([key, code]) => [join(dir, `__type_case_${key}__.ts`), { key, code }]));
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => {
    const own = files.get(name);
    return own ? ts.createSourceFile(name, own.code, lang) : read(name, lang, ...rest);
  };
  const exists = host.fileExists.bind(host);
  host.fileExists = (name) => files.has(name) || exists(name);
  const program = ts.createProgram([...files.keys()], options, host);
  const out: Record<string, TypeDiagnostic[]> = Object.fromEntries(Object.keys(snippets).map((k) => [k, []]));
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const own = d.file && files.get(d.file.fileName);
    if (own) out[own.key].push({ code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') });
  }
  return out;
}

/**
 * A negative case: `base` with exactly one edit, `from` replaced by `to`. Throws unless `from` occurs
 * exactly once — overlapping occurrences included — because an anchor that matches twice edits a place
 * nobody chose, and the case then fails (or passes) for a reason its name does not state.
 *
 * One copy, here. It began as ten, one per test file, and within a day they had split into two
 * behaviours: a `split`-based copy accepted `'aa'` in `'aaa'` and edited the first match silently.
 */
export function mutate(base: string, from: string, to: string): string {
  const at = base.indexOf(from);
  if (from === '' || at < 0 || base.indexOf(from, at + 1) >= 0) throw new Error(`mutation anchor must occur exactly once: ${from}`);
  return base.slice(0, at) + to + base.slice(at + from.length);
}

// @gnldev/auth's `EngineCaller` is written structurally so auth depends on nothing; durable's `Caller`
// is the engine's own. ADR-0002 point 2 needs them to be ONE shape: a door maps a principal with
// `engineCallerOf` and hands the result to the engine unchanged. This holds the two to each other in
// BOTH directions, as the published declarations (dist) state them — server depends on both packages,
// so this is where the two meet.
//
// Type-level, so it runs the compiler: vitest does not type-check test files, and an `expectTypeOf` here
// would pass at runtime whatever the types said. A negative control proves the check can fail.
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { join } from 'node:path';

const HERE = join(__dirname, '__engine_caller_shape__.ts');

function diagnostics(code: string): string[] {
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => (name === HERE ? ts.createSourceFile(name, code, lang) : read(name, lang, ...rest));
  const exists = host.fileExists.bind(host);
  host.fileExists = (name) => name === HERE || exists(name);
  const program = ts.createProgram([HERE], options, host);
  return ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === HERE).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const BOTH_WAYS = `
import type { EngineCaller } from '@gnldev/auth';
import type { Caller } from '@gnldev/durable';
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<EngineCaller, Caller> = true;
declare const e: EngineCaller; const c: Caller = e;
declare const d: Caller; const f: EngineCaller = d;
// each kind, too — a union can be mutually assignable while one member drifted into another
type K<U, T> = Extract<U, { kind: T }>;
const u: Same<K<EngineCaller, 'user'>, K<Caller, 'user'>> = true;
const s: Same<K<EngineCaller, 'staff'>, K<Caller, 'staff'>> = true;
const n: Same<K<EngineCaller, 'unknown'>, K<Caller, 'unknown'>> = true;
export { same, c, f, u, s, n };
`;

describe('EngineCaller (@gnldev/auth) and Caller (@gnldev/durable) are one shape', () => {
  it('assignable both ways, kind by kind', () => {
    expect(diagnostics(BOTH_WAYS)).toEqual([]);
  }, 60_000);

  it('the check can fail (negative control: a drifted shape is caught)', () => {
    const drifted = BOTH_WAYS.replace(
      "import type { Caller } from '@gnldev/durable';",
      "type Caller = { kind: 'user'; id: string; orgId?: string } | { kind: 'staff'; orgId?: string; actor: string } | { kind: 'unknown' };",
    );
    expect(diagnostics(drifted).length).toBeGreaterThan(0);
  }, 60_000);
});

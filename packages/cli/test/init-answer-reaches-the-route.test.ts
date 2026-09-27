// The answer a person gave has to reach the file that acts on it.
//
// `gnl init --identity end-users` writes `src/identity.ts` — a real resolver skeleton, and the file's
// own header calls it "the single most security-relevant function a host writes". Then the route that
// needs it, `src/routes/chat.ts`, was generated with `identity: (_req) => undefined` and a comment
// telling the reader to wire it up by hand — while the answer that says they want it was already in
// the scaffold's hands.
//
// Measured before this: diffing a `--identity end-users` project against a `--identity internal` one,
// the ONLY difference was the presence of `src/identity.ts`. `src/routes/chat.ts` was byte-identical.
// The generator that writes the route (`recipes.ts`) read none of the four answers — not identity, not
// preset, not store, not serving — so the file could not have differed.
//
// The protections matrix was the one honest surface in that flow: it printed `○ identity not bound —
// declared 'subjects: end-users' but nothing in front of THIS surface resolves one`. It was right, and
// it was describing a gap the scaffold could have closed itself.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../src/scaffold.js';

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'gnl-answer-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ANSWERS = (identity: 'internal' | 'end-users') =>
  ({ preset: 'assistant', identity, store: 'sqlite', serving: 'own' }) as never;

describe('gnl init --identity end-users', () => {
  it('wires the resolver it wrote into the route that needs it', () => {
    const dir = fresh();
    scaffold(dir, { answers: ANSWERS('end-users'), host: 'hono' });

    expect(existsSync(join(dir, 'src/identity.ts')), 'the resolver file is the point of the answer').toBe(true);
    const route = readFileSync(join(dir, 'src/routes/chat.ts'), 'utf8');
    expect(route, 'the answer reached the file that wrote the resolver but not the file that uses it')
      .toMatch(/^import \{ identity \} from '..\/identity.js';$/m);
    expect(route, 'the placeholder resolver is still there — nothing was replaced')
      .not.toContain('identity: (_req) => undefined');
  });

  it('leaves the internal answer exactly as it was', () => {
    // The control. `internal` means "no subject by design" — wiring a resolver there would invent a
    // requirement the person declined, and the matrix would then print `✓` for a posture nobody chose.
    const dir = fresh();
    scaffold(dir, { answers: ANSWERS('internal'), host: 'hono' });
    const route = readFileSync(join(dir, 'src/routes/chat.ts'), 'utf8');
    expect(route).toContain('identity: (_req) => undefined');
    expect(existsSync(join(dir, 'src/identity.ts'))).toBe(false);
  });
});

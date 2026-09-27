// What `gnl init --identity end-users` writes, now that end users hold a token of their own.
//
// It used to write `src/identity.ts` as an `identity(req)` hook for a standalone chat route — a second
// copy of the auth decision, which the route then had to import (87916a79 wired that import). The chat
// format is a surface of the REST API now, so the API's `auth` decides who a turn belongs to, and the
// answer's job is different: give the app a way to hand each user a token (`subjectTokenEndpoint`).
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
  it('writes the token route your app mounts, and forbids reading the user from the body', () => {
    const dir = fresh();
    scaffold(dir, { host: 'hono', answers: ANSWERS('end-users') });
    const identity = readFileSync(join(dir, 'src/identity.ts'), 'utf8');
    expect(identity).toContain("import { subjectTokenEndpoint } from '@gnldev/auth';");
    expect(identity).toMatch(/export async function gnlToken\(req: Request\)/);
    expect(identity).toContain('GNL_END_USER_SECRET');
    expect(identity).toMatch(/NEVER:\s*\n\s*\/\/\s*const userId = \(await req\.json\(\)\)\.userId;/);
  });

  it('the chat file is the same for both answers: identity is not its business', () => {
    const a = fresh(); const b = fresh();
    scaffold(a, { host: 'hono', answers: ANSWERS('end-users') });
    scaffold(b, { host: 'hono', answers: ANSWERS('internal') });
    expect(readFileSync(join(a, 'src/routes/chat.ts'), 'utf8')).toBe(readFileSync(join(b, 'src/routes/chat.ts'), 'utf8'));
    expect(existsSync(join(b, 'src/identity.ts'))).toBe(false);
  });

  it('the app reads end-user tokens from the environment and serves chat on the same door', () => {
    const dir = fresh();
    scaffold(dir, { host: 'hono', answers: ANSWERS('end-users') });
    const app = readFileSync(join(dir, 'src/app.ts'), 'utf8');
    expect(app).toContain('GNL_END_USER_SECRET');
    expect(app).toContain('surfaces: [chat]');
    const server = readFileSync(join(dir, 'src/server.ts'), 'utf8');
    expect(server, 'chat is not mounted a second time').not.toContain('routes/chat');
  });
});

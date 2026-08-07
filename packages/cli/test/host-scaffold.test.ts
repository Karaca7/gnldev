// What `gnl init --host <x>` actually writes.
//
// The recipes are copied from a rig where each was measured against the running server, so what
// matters here is not whether the binding works — that was established elsewhere — but that the
// scaffold delivers it intact: the right two files, the framework's dependency, a way to start it,
// and a README that says where the choice applies. A generated project that needs a correction
// before it runs is worse than no generation at all.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../src/scaffold.js';
import { HOSTS, HOST_IDS } from '../src/hosts.js';

const dirs: string[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'gnl-host-'));
  rmSync(d, { recursive: true, force: true }); // scaffold requires an empty/absent dir
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

describe('gnl init --host', () => {
  it.each(HOST_IDS)('%s: writes both halves, its dependency, and a start script', (id) => {
    const dir = fresh();
    scaffold(dir, { template: 'minimal', host: id });

    // Two files, not one. `app.ts` is what the edge targets and the managed runtime consume; the
    // server choice must not reach into it, or the choice becomes a fork in the road.
    expect(existsSync(join(dir, 'src/app.ts'))).toBe(true);
    expect(existsSync(join(dir, 'src/server.ts'))).toBe(true);

    const server = readFileSync(join(dir, 'src/server.ts'), 'utf8');
    expect(server).toContain("from './app.js'");

    const p = pkg(dir);
    expect(p.scripts.start).toBe('tsx src/server.ts');
    for (const dep of Object.keys(HOSTS.find((h) => h.id === id)!.deps ?? {})) {
      expect(p.dependencies[dep], `${id} needs ${dep}`).toBeTruthy();
    }
  });

  it('says where the choice applies — and where it does not', () => {
    // Asking "which server?" is a promise. It does not hold on the managed cloud, where the runtime
    // is ours, and it does not apply on the edge, where no Node framework runs. A user who picks
    // Fastify, deploys to a managed host and finds the choice ignored was mis-sold by the question.
    const dir = fresh();
    scaffold(dir, { template: 'minimal', host: 'fastify' });
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('Fastify');
    expect(readme).toMatch(/a managed host.*(does not|Hono)/s);
    expect(readme).toMatch(/edge/i);
  });

  it('writes nothing server-shaped when no host is chosen', () => {
    // The old behaviour, kept: `gnl dev` serves the project without a server file, and --yes must
    // not silently pick a framework on the user's behalf.
    const dir = fresh();
    scaffold(dir, { template: 'minimal' });
    expect(existsSync(join(dir, 'src/server.ts'))).toBe(false);
    expect(pkg(dir).scripts.start).toBeUndefined();
  });

  it('composes with features rather than replacing them', () => {
    const dir = fresh();
    const res = scaffold(dir, { features: ['memory', 'workflow'], host: 'express' });
    expect(res.files).toContain('src/server.ts');
    expect(res.files).toContain('src/memory.ts');
    expect(existsSync(join(dir, 'gnl.config.ts'))).toBe(true);
    expect(pkg(dir).dependencies.express).toBeTruthy();
  });

  it('refuses a host it does not have a measured recipe for', () => {
    expect(() => scaffold(fresh(), { template: 'minimal', host: 'deno' })).toThrow(/unknown host/);
  });

  it('every recipe carries the ordering rule it depends on', () => {
    // These files are the only place a user meets the two rules that took a live server to find.
    // A recipe that drops the explanation still works today and breaks silently the day someone
    // reorders it — so the explanation travels with the code, not with the docs.
    for (const h of HOSTS) {
      if (h.id === 'hono') { expect(h.server, h.id).toMatch(/MOUNT ORDER/); continue; }
      if (h.id === 'node') { expect(h.server, h.id).toMatch(/prefix/i); continue; }
      expect(h.server, h.id).toMatch(/MIDDLEWARE layer/);
      expect(h.server, h.id).toMatch(/BEFORE whatever parses request bodies/);
    }
  });
});

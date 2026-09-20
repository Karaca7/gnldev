#!/usr/bin/env node
// CLI: `gnl-semantic-qualify --judge ./my-judge.mjs --model <id> [--fixtures a.json,b.json] [--out cert.json]`
//
// The judge module must default-export (or export `complete`) the SAME closure the runtime gets:
//   export default async ({ system, user }) => (await callYourModel(system, user)).text
//
// Exit code is the verdict: 0 passed (certificate written), 1 failed, 2 usage/loading error. That
// makes the exam usable as a CI gate — a model swap that quietly degrades the judge fails the build
// instead of shipping a layer that looks installed.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyJudge, formatReport, defaultFixturePaths } from './index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const judgePath = arg('judge');
  const judgeModelId = arg('model');
  if (!judgePath || !judgeModelId) {
    console.error('usage: gnl-semantic-qualify --judge ./judge.mjs --model <judgeModelId> [--fixtures a.json,b.json] [--out gnl-judge-cert.json] [--concurrency 4] [--limit N>=20]');
    console.error('  the judge module exports a closure: async ({ system, user }) => string');
    return 2;
  }
  const mod = (await import(pathToFileURL(resolve(judgePath)).href)) as { default?: unknown; complete?: unknown };
  const complete = (typeof mod.default === 'function' ? mod.default : mod.complete) as
    | ((req: { system: string; user: string }) => Promise<string>)
    | undefined;
  if (typeof complete !== 'function') {
    console.error(`@gnldev/semantic-qualify: ${judgePath} must default-export (or export 'complete') an async ({ system, user }) => string closure.`);
    return 2;
  }

  const fixtures = arg('fixtures')?.split(',').map((f) => resolve(f.trim())) ?? defaultFixturePaths();
  const concurrency = Number(arg('concurrency') ?? 4);
  const limitRaw = arg('limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    console.error(`@gnldev/semantic-qualify: --limit must be a positive number, got '${limitRaw}'`);
    return 2;
  }
  process.stderr.write(`examining ${judgeModelId} on ${fixtures.length} fixture file(s)...\n`);
  const report = await qualifyJudge({
    complete, judgeModelId, fixtures, concurrency, ...(limit === undefined ? {} : { limit }),
    onProgress: (done, total) => { if (done % 25 === 0 || done === total) process.stderr.write(`\r  ${done}/${total}`); },
  });
  process.stderr.write('\n\n');
  console.log(formatReport(report));

  if (report.cert) {
    const out = arg('out') ?? 'gnl-judge-cert.json';
    writeFileSync(out, `${JSON.stringify(report.cert, null, 2)}\n`);
    console.log(`\ncertificate written to ${out} — pass it as semantic.judge.qualification`);
    return 0;
  }
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err); process.exit(2); },
);

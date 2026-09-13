// gnl add <feature> — drop a boilerplate recipe into an existing project + print the config wiring.
// Deliberately does NOT rewrite gnl.config.ts (AST patching is fragile): it writes a src/ file
// (idempotent — never overwrites) and prints exactly what to add to the config object.
// Recipes live in ../recipes.ts (shared with `gnl init`'s feature composition).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from './types.js';
import { positional } from '../args.js';
import { bold, cyan, dim, green, yellow } from '../ansi.js';
import { RECIPES, recipeContents } from '../recipes.js';

export const addCommand: Command = {
  name: 'add',
  group: 'project',
  summary: 'Add a feature recipe to an existing project (idempotency-tool|rag|mcp|memory|workflow|auth)',
  usage: 'gnl add <idempotency-tool|rag|mcp|memory|workflow|auth>',
  async run(ctx) {
    const feature = positional(ctx.argv, 0);
    const names = Object.keys(RECIPES);
    if (!feature || !RECIPES[feature]) {
      console.error(`gnl add: ${feature ? `unknown feature '${feature}'` : 'missing feature'}`);
      console.error(`  available: ${names.join(', ')}`);
      process.exit(1);
    }
    if (!existsSync(resolve('gnl.config.ts'))) {
      console.error("gnl add: no gnl.config.ts here — run this inside a gnl project (gnl init).");
      process.exit(1);
    }
    const r = RECIPES[feature]!;
    const target = resolve(r.file);
    if (existsSync(target)) {
      console.log(`${yellow('•')} ${r.file} already exists — leaving it untouched.`);
    } else {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, recipeContents(r));
      console.log(`${green('✓')} created ${bold(r.file)}`);
    }
    console.log(`\n${cyan('Add to gnl.config.ts:')}`);
    for (const line of r.humanWire.split('\n')) console.log(`  ${line}`);
    if (r.note) console.log(`\n${dim('note: ' + r.note)}`);
    if (r.dep) console.log(`\n${dim(`then: pnpm add ${r.dep}   (if not already a dependency)`)}`);
  },
};

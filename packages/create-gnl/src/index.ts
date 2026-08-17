#!/usr/bin/env node
// `npm create gnl [dir]` — calls @gnldev/cli's scaffold() (single source).
import { scaffold } from '@gnldev/cli';

const arg = process.argv[2];

// `--help` used to fall through to `dir = '.'` and try to scaffold into the CURRENT directory, which
// in a non-empty one printed "target directory is not empty" — an error, for a request for help.
if (arg === '--help' || arg === '-h') {
  console.log('Usage: npm create gnl [dir]');
  console.log('');
  console.log('  Scaffolds a gnl project (mock model, no API key needed). Defaults to the current');
  console.log('  directory, which must be empty.');
  console.log('');
  console.log('  For templates, features and hosts, use the CLI directly:');
  console.log('    npx @gnldev/cli init [dir] [--template minimal|full] [--features a,b,c] [--yes]');
  process.exit(0);
}

const dir = arg && !arg.startsWith('--') ? arg : '.';

try {
  const res = scaffold(dir);
  console.log(`✓ gnl project created: ${res.dir}  (${res.files.length} files)`);
  console.log(`  cd ${dir}  &&  pnpm install  &&  pnpm dev`);
  console.log('  then open http://localhost:3000/studio');
} catch (e) {
  console.error('create-gnl:', (e as Error).message);
  process.exit(1);
}

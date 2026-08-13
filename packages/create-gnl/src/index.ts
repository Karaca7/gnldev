#!/usr/bin/env node
// `npm create gnl [dir]` — calls @gnldev/cli's scaffold() (single source).
import { scaffold } from '@gnldev/cli';

const arg = process.argv[2];
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

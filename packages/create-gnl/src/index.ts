#!/usr/bin/env node
// `npm create gnl [dir]` — calls @gnldev/cli's scaffold() (single source).
import { scaffold } from '@gnldev/cli';

const arg = process.argv[2];
const dir = arg && !arg.startsWith('--') ? arg : '.';

try {
  const res = scaffold(dir);
  console.log(`✓ gnl project created: ${res.dir}  (${res.files.length} files)`);
  console.log(`  cd ${dir}  &&  pnpm install  &&  pnpm dev`);
  console.log(
    '  NOTE: @gnldev/* packages are not yet published to npm — for now this template only works ' +
      'INSIDE the gnl monorepo: create the project in a directory covered by the workspace (e.g. under examples/); ' +
      '@gnldev/* dependencies are linked locally via link-workspace-packages=true in .npmrc. ' +
      'To use it outside the monorepo, wait for the @gnldev/* packages to be published to npm.',
  );
} catch (e) {
  console.error('create-gnl:', (e as Error).message);
  process.exit(1);
}

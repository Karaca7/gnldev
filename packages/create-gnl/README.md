# create-gnl

`npm create gnl <project-name>` — scaffolds a durable agent project. Calls `@gnldev/cli`'s
`scaffold()` (single source); template files are kept in `packages/cli/templates/default`.

```bash
npm create gnl my-agent
cd my-agent
pnpm install
pnpm dev   # REST API + Studio Playground → http://localhost:3000/studio
```

## Important: publication status
The `@gnldev/*` packages (durable, server, studio, cli, ...) are not yet published to npm. Because of
this, the generated template project **cannot be installed with `pnpm install` outside the
`gnl` monorepo** — the dependencies can't be found on the npm registry.

For now there are two options:
1. Run it inside the monorepo: call `scaffold()` directly from `packages/cli`'s src, or run
   `pnpm --filter create-gnl build && node packages/create-gnl/dist/index.js <target-dir>` to
   write the target into `gnl` (or somewhere covered by the workspace) and run `pnpm install`.
2. Link the `@gnldev/*` packages locally with `pnpm link --global`.

This restriction will go away once the `@gnldev/*` packages are published to npm.

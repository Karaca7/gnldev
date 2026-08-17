# create-gnl

`npm create gnl <project-name>` — scaffolds a durable agent project. Calls `@gnldev/cli`'s
`scaffold()` (single source); template files are kept in `packages/cli/templates/` (`minimal`, `full`, and the `_e2e` add-on).

```bash
npm create gnl my-agent
cd my-agent
pnpm install
pnpm dev   # REST API + Studio Playground → http://localhost:3000/studio
```


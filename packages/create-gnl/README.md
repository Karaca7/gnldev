# create-gnl

`npm create gnl <project-name>` — scaffolds a durable agent project. A thin door: it forwards to
`@gnldev/cli`'s `init` command (single source), which is also what `gnl init` runs inside an existing
project. Template files live in `packages/cli/templates/minimal` (plus the `_e2e` add-on `--e2e`
copies in); everything beyond the base comes from the recipes in `packages/cli/src/recipes.ts`.

```bash
npm create gnl@latest my-agent
cd my-agent && pnpm install
pnpm test   # the proof: one order, three duplicate tool-calls in one turn → charged once
pnpm dev    # REST API + Studio Playground → http://localhost:3000/studio
```

In an interactive terminal it opens one gate — Recommended · Let me choose · Same as last time — and,
if you choose, four questions: what a repeated piece of work should do, who each run belongs to,
where the record is kept, and how people will reach it. `--yes` skips all of them, so CI never sees a
prompt.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

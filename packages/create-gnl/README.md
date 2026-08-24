# create-gnl

`npm create gnl <project-name>` — scaffolds a durable agent project. Calls `@gnldev/cli`'s
`scaffold()` (single source); template files are kept in `packages/cli/templates/` (`minimal`, `full`, and the `_e2e` add-on).

> **`npm create gnl` does not work yet.** The name on npm (`create-gnl@0.0.1`) is a name-holding
> placeholder — it scaffolds nothing — and the `@gnldev/*` packages it would install are unpublished.
> Until the first release, scaffold from a [repo clone](https://github.com/Karaca7/gnl-framework) instead:

```bash
git clone https://github.com/Karaca7/gnl-framework.git gnl && cd gnl
pnpm install && pnpm -r build
cd examples && node ../packages/create-gnl/dist/index.js my-agent   # inside examples/ → @gnldev/* resolve via workspace links
cd my-agent && pnpm install
pnpm dev   # REST API + Studio Playground → http://localhost:3000/studio
```

After the npm release the whole thing collapses back into the one-liner it is meant to be:

```bash
npm create gnl my-agent
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).

# @gnldev/docs-mcp

**Stdio server that serves GNL docs to AI assistants over MCP (Model Context Protocol).** Any MCP-compatible CLI or editor starts this server as a child process and can query GNL's features (install/API/example) with the `gnl_docs_overview` / `gnl_docs_feature` / `gnl_docs_search` tools.

Hand-written JSON-RPC 2.0 — **`@modelcontextprotocol/sdk` is NOT USED** (zero new dependencies: only `node:readline`/`node:process`). Content is first tried via a live fetch of `/llms.txt` + `/llms-full.txt` through `GNL_DOCS_URL` (default `https://gnl.dev`); if the network is unavailable/unreachable, it falls back to the static content embedded in the package (`src/content.ts`) — this package works on its own even if the site is down.

> **Not on npm yet** — no `@gnldev/*` package has been published, so the `npx` form below cannot resolve either. Until the first release, point your MCP client at a [repo clone](https://github.com/Karaca7/gnl-framework) (`pnpm install && pnpm -r build`, then run `node packages/docs-mcp/dist/cli.js`).

```bash
npm i -g @gnldev/docs-mcp   # or npx @gnldev/docs-mcp (no dependencies, runs the stdio server directly)
```

## Adding via a CLI's `mcp add`

```bash
claude mcp add gnl-docs -- npx -y @gnldev/docs-mcp
```

## Editors — `mcp.json`

```json
{
  "mcpServers": {
    "gnl-docs": {
      "command": "npx",
      "args": ["-y", "@gnldev/docs-mcp"]
    }
  }
}
```

To run locally from within the monorepo (before publishing):

```json
{
  "mcpServers": {
    "gnl-docs": {
      "command": "node",
      "args": ["/absolute/path/packages/docs-mcp/dist/cli.js"]
    }
  }
}
```

## Environment variables

- `GNL_DOCS_URL` — doc source (default `https://gnl.dev`). Passing an empty string (`''`) has the same effect as `GNL_DOCS_OFFLINE=1`.
- `GNL_DOCS_OFFLINE` — if `1`/`true`, the live fetch is skipped entirely and embedded content is always used (for tests and network-less environments).

## Tools (`tools/list`)

- `gnl_docs_overview()` → GNL summary + ordered list of the features.
- `gnl_docs_feature({ slug })` → installation/API/example detail for that feature (unknown `slug` → info text listing valid slugs, not a JSON-RPC error).
- `gnl_docs_search({ query })` → simple (case-insensitive) text search.

## How it works

`src/cli.ts` reads stdin line by line (`node:readline`) and hands each line to `src/server.ts#handleMessage` as a JSON-RPC 2.0 message; responses are written to stdout as single-line JSON (newline-delimited, the format expected by the MCP stdio transport). `initialize` → returns `protocolVersion: '2024-11-05'` + `serverInfo`; messages without an `id` field (notifications, e.g. `notifications/initialized`) are NEVER responded to, per JSON-RPC 2.0. Unknown method → `-32601`; in `tools/call`, an unknown tool/missing argument → a tool-level `isError: true` result (not a JSON-RPC error, per the MCP contract).

As a library (test/embedding): `import { createDocsProvider, handleMessage, TOOLS } from '@gnldev/docs-mcp'` — `src/index.ts` is the public export; the CLI's stdio side effects (`process.stdin`/`process.exit`) are kept in a separate file (`src/cli.ts`), so importing `index.ts` never starts a stdio server.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

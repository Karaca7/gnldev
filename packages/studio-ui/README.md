# @gnldev/studio-ui

The Studio single-page app: a React + Vite build that `@gnldev/studio` serves as prebuilt static
assets.

**You almost certainly do not need to install this directly.** It is a build artifact of the Studio
package — `@gnldev/studio` resolves it at runtime and serves `dist/`. Install `@gnldev/studio`
instead and open `/studio`.

## What it renders

Fifteen views over a run journal, including:

- **Playground** — talk to an agent and watch the journal fill in
- **Inspector** — a run step by step, with time-travel and fork from any point
- **Workflows**, **Networks** — the shape a run actually took, not the shape it was meant to take
- **Approvals** — the queue of tool calls waiting on a human
- **Evals**, **Observability**, **Audit**, **Policy**, **Organizations**, **Users**

## Building it

```bash
pnpm --filter @gnldev/studio-ui build
```

The build also regenerates `dist/THIRD-PARTY-NOTICES.txt`. That step **fails the build** if a
bundled dependency ships without a license file, so the notices cannot quietly fall out of date.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

Bundled third-party dependencies keep their own licenses; see `dist/THIRD-PARTY-NOTICES.txt` in the
published package.

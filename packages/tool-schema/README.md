# @gnldev/tool-schema

Tool schemas that one provider accepts and another rejects, smoothed over.

The same JSON Schema does not travel cleanly between OpenAI, Gemini and Anthropic: one rejects
`format` on strings, another dislikes certain nested constructs. This package rewrites a tool's
schema for the model actually being called.

## Install

> **Not on npm yet** — no `@gnldev/*` package has been published. Until the first release, use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/tool-schema
```

## Use

It is opt-in from `@gnldev/durable`:

```ts
import { defaultRules } from '@gnldev/tool-schema';

const gnl = createGnl({ ...config, schemaCompat: defaultRules });
// or per call: runDurable({ runId, journal, model, tools, schemaCompat: true, prompt })
```

Or directly:

```ts
import { applyToolCompat, detectModel, defaultRules } from '@gnldev/tool-schema';

const safe = applyToolCompat(tools, detectModel(modelId), defaultRules);
```

## Exports

| Export | What it is |
|---|---|
| `detectModel` | Model id → which provider family it belongs to |
| `applyToolCompat` | Applies the matching rules to a tool set |
| `defaultRules` | The bundled rule set (OpenAI / Gemini / Anthropic) |
| `ToolSchemaRule` | The rule interface — add your own for a provider not covered here |

Rules are ordinary objects, so a provider the default set does not know about is a rule you write
rather than a fork you maintain.

## One thing the OpenAI rule changes that you will see

OpenAI's strict mode has no notion of an optional property: every key of an object must be listed in
`required`. So the rule lists them all — and widens the ones that **were** optional to also accept
`null`, which is the only way strict mode can express "not supplied":

```
z.object({ to: z.string(), cc: z.string().optional() })
→  required: ["to", "cc"],  cc: { type: ["string", "null"] }
```

Without the second half the parameter is silently promoted to mandatory. Under `strict: true` the
model then has no way to leave it out; without strict, `required` is still what it is told the tool
wants. Keys that were genuinely required are left alone.

An `enum` gets `null` added to its **values** too, and a `const` is wrapped in `anyOf` rather than
widened in place — in both cases changing only `type` would leave a node whose type admits `null`
while its value constraint forbids it, which nothing can satisfy.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

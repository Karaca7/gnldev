# @gnldev/schema-compat

Tool schemas that one provider accepts and another rejects, smoothed over.

The same JSON Schema does not travel cleanly between OpenAI, Gemini and Anthropic: one rejects
`format` on strings, another dislikes certain nested constructs. This package rewrites a tool's
schema for the model actually being called.

## Install

```bash
npm i @gnldev/schema-compat
```

## Use

It is opt-in from `@gnldev/durable`:

```ts
import { defaultRules } from '@gnldev/schema-compat';

const gnl = createGnl({ ...config, schemaCompat: defaultRules });
```

Or directly:

```ts
import { applyToolCompat, detectModel, defaultRules } from '@gnldev/schema-compat';

const safe = applyToolCompat(tools, detectModel(modelId), defaultRules);
```

## Exports

| Export | What it is |
|---|---|
| `detectModel` | Model id → which provider family it belongs to |
| `applyToolCompat` | Applies the matching rules to a tool set |
| `defaultRules` | The bundled rule set (OpenAI / Gemini / Anthropic) |
| `SchemaCompatRule` | The rule interface — add your own for a provider not covered here |

Rules are ordinary objects, so a provider the default set does not know about is a rule you write
rather than a fork you maintain.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

# @gnl/processors

**Input/output processors** for `@gnl/durable` agents: PII masking, moderation, tool filtering, safety.
Built-ins inherit durability — input processors run before `persistInput` (masking is journaled → doesn't
run again on resume).

```bash
npm i @gnl/processors   # peer: @gnl/durable
```

```ts
import { runDurable } from '@gnl/durable';
import { piiRedactor, moderationProcessor, toolFilter } from '@gnl/processors';

await runDurable({
  runId: 'r1', journal, model, prompt: '...',
  processors: [
    piiRedactor(),                                    // mask email/phone/card
    moderationProcessor({ blocklist: ['...'] }),      // tripwire on blocked content
    toolFilter({ allow: ['searchPolicy', 'lookupOrder'] }), // restrict the tool set the model sees
  ],
});
```

## API
- `piiRedactor(opts?)` · `moderationProcessor(opts?)` · `toolFilter(opts?)`
- `tokenLimit(...)` · `promptInjectionDetector(...)` · `outputLimit(...)`
- Lower-level: `redactString`, `redactMessages`, `PII_PATTERNS`
- Re-exported: the `Processor` type + `ProcessorTripwire` (importable from a single package)

## How it works
The processor pipeline is passed to `runDurable`/`createGnl` config. Pure transforms (masking) are
deterministic; non-deterministic ones are journaled via `ctx.step` → same result on replay. When a
tripwire fires, the run stops safely.

## Limitations — an honest warning

`moderationProcessor`, `promptInjectionDetector`, `piiRedactor`, and `untrustedToolContent` use **naive
substring/regex matching**. This means they:

- **Are easily bypassed** — by adding whitespace/punctuation, typos, unicode homoglyphs, paraphrasing,
  encoding (base64, etc.), or another language.
- **Are NOT a real security/compliance boundary** — prompt-injection defense is still an unsolved problem
  in LLM safety; PII regexes don't guarantee GDPR/HIPAA/PCI-DSS-level detection.
- **Are designed as a first line of defense / noise-reduction layer.** For a critical flow (payment, data
  deletion, external authorization), don't use these as the ONLY protection mechanism — combine them with
  additional layers like a model-based judge, human approval, or least-privilege design.

For details, see the JSDoc on the relevant functions (`src/moderation.ts`, `src/safety.ts`, `src/pii.ts`,
`src/redact.ts`).

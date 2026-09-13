# @gnldev/processors

**Input/output processors** for `@gnldev/durable` agents: PII masking, moderation, tool filtering, safety.
Built-ins inherit durability — input processors run before `persistInput` (masking is journaled → doesn't
run again on resume).

> Install: `pnpm add @gnldev/processors` — or use it from a [repo clone](https://github.com/Karaca7/gnl-framework): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/processors   # peer: @gnldev/durable
```

```ts
import { runDurable } from '@gnldev/durable';
import { piiRedactor, moderationProcessor, toolFilter } from '@gnldev/processors';

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
- `piiTextRedactor(opts?) → (text: string) => string` — the same masking as `piiRedactor`, as a plain
  string function, for text that never passes through a processor at all. A `Processor` only sees
  `processInput`/`processOutput`/`processToolResult`; a run's failure message is written by
  `recordRunOutcome` in `@gnldev/durable` and no processor is consulted about it, yet it can carry user
  data (providers echo the offending input back when refusing). Wire it wherever that message is
  shipped onward — `@gnldev/otel`'s `redact` option is the case it was added for. Takes `types`/`mask`
  and shares `piiRedactor`'s defaults, on purpose: two copies of the defaults is how the redacted path
  and the un-redacted one drift apart.
- Lower-level: `redactString`, `redactMessages`, `PII_PATTERNS`, `PII_VALIDATORS`, `PiiPattern`, `luhn`, `ibanMod97`

### Checksums: why any sixteen digits is not a card

Some identifiers carry their own check digit, so whether a match is real is arithmetic rather than a
guess. `creditCard` is validated with Luhn and `iban` with mod-97, and a match that fails its own
check is left alone:

| Text | Masked |
|---|---|
| `kart 4111 1111 1111 1111` | yes — Luhn holds |
| `siparis 1234567812345678` | **no** — same shape, not a card |
| `TR330006100519786457841326` | yes — mod-97 holds |
| one digit changed | **no** |

The trade is real: a card typed with a wrong digit fails Luhn and is then not masked. Pass
`validate: false` to mask on shape alone — blunter, corrupts more text, but cannot be talked out of
masking anything.

`phone` has no checksum to appeal to, so it is bounded by shape instead: 7–15 digits, and short
groups once a number is split. That replaced a pattern which counted *characters*, and so masked
`2024-01-15 10` out of a timestamp, the whole of `1.2.3 - 4.5.6`, and a run id — text corruption in
exactly the payload it most often runs over. It is checked against 24 written forms across a dozen
countries, and against non-PII text that has to survive — both directions, because a first attempt
verified against a set chosen *after* the rule was written passed while `+49 30 12345678`,
`+90 5321112233` and `0212 5551234` were going through unmasked.

A match that fails its checksum is **skipped, not consumed**. That matters: with a plain
`String.replace`, a candidate spanning `1234567890 555-123-4567` failed the digit count and took the
real number out of reach of every later pattern — a leak caused by the validator meant to prevent one.

### Masking an identifier the built-ins cannot name

National ids are a per-country long tail, so they are not shipped here — `extraPatterns` is how you
add your own, with the same checksum power the built-ins have:

```ts
import { piiRedactor } from '@gnldev/processors';

piiRedactor({
  extraPatterns: [
    { name: 'mrn', pattern: /\bMRN-\d{6}\b/g },
    // `test` is where the identifier's own checksum goes, so a custom pattern is as precise as a built-in.
    { name: 'tckn', pattern: /\b\d{11}\b/g, mask: '[TCKN]', test: (v) => v[10] === String(
      ([...v.slice(0, 10)].reduce((n, d) => n + Number(d), 0)) % 10) },
  ],
});
```

They run **before** the built-ins, and that ordering is load-bearing: `phone` would otherwise reach an
11-digit national id first and mask it under the wrong name — which would also make the audit report
say the wrong type. Custom names appear in `recordProcessorReport` alongside the built-in ones, and
the counts come off the same call that performs the redaction, so the report cannot describe a masking
that did not run. A pattern without the `g` flag gets it added, rather than quietly masking only the
first occurrence.

A name in `types` with no pattern behind it is **refused at construction** instead of masking nothing
in silence; `piiTextRedactor` takes the same options.
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

## License

Apache-2.0 — see [LICENSE](./LICENSE).

# @gnldev/semantic-qualify

The exam a judge closure must sit before `@gnldev/durable` will run it.

## Why this exists

GNL's semantic gate can ask a model one question — *"do these two records name the same real-world
thing?"* — when its deterministic rules cannot settle a pair. That question is only worth asking if
the model can answer it. On identical fixtures with the identical prompt we measured **one model at
43% paraphrase recall and another at 100%**. A judge nobody measured is a layer that looks installed
and is not, so the runtime refuses an uncertified closure at config time. This package is where the
certificate comes from.

## Use

```sh
npx gnl-semantic-qualify --judge ./my-judge.mjs --model your-judge-model
```

Your judge module exports the same closure the runtime calls — transport only, since the prompt
belongs to the framework:

```js
// my-judge.mjs
export default async ({ system, user }) => (await callYourModel(system, user)).text;
```

**Give that call a timeout.** Without one a hung request never returns and the bench cannot tell you
so: it sits there, the progress counter does not move, and "the model is slow" looks exactly like
"the model is gone". Measured while writing this page — a judge with no timeout ran 14 minutes and
completed zero pairs; the same judge with one finished 20 pairs in 20 seconds. On a CI gate, which
is what the paragraph above recommends, the difference is a job that fails in minutes versus one
that burns its whole budget.

```js
// my-judge.mjs — the same closure, with the one line that makes a stall visible
export default async ({ system, user }) => {
  const res = await fetch(MY_ENDPOINT, {
    signal: AbortSignal.timeout(90_000),   // ← a stalled request aborts instead of waiting forever
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MY_KEY}` },
    body: JSON.stringify({ model: MY_MODEL, temperature: 0, max_tokens: 200,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? '';
};
```

The bench counts a throw as an `error` and keeps going, so one dead request costs one pair rather
than the whole run.

**One more thing the transport decides: WHERE the model puts its answer.** A reasoning model that
writes its thinking into `content` produces text the parser cannot read, and every pair lands in
`unparsed` — the report says so in its first line, because that is a format failure, not a
judgement one. Models that keep reasoning in a separate field (`reasoning_content`) parse cleanly.
Check one raw reply before concluding a model is bad at the task.

Output is a table plus `gnl-judge-cert.json`, which you paste into config as
`semantic.judge.qualification`. The exit code is the verdict (`0` pass, `1` fail, `2` usage error),
so the exam works as a CI gate: a model swap that quietly degrades the judge fails the build instead
of shipping a layer that no longer protects anything.

```
judge: your-judge-model   prompt: v1   fixtures: 946bdc7ebee3fa34 (300 pairs)

  dup-exact        100%  (75/75)
  dup-paraphrase    61%  (46/75)
  near-miss         67%  (50/75)
  unrelated        100%  (75/75)

  paraphrase recall   61.3%   (required >= 70%)
  near-miss false alarm 33.3%   (allowed <= 5%)

  FAILED — paraphrase recall 0.613 < required 0.7; near-miss false alarms 0.333 > allowed 0.05
```

A failing run prints the pairs it got wrong, so the result is diagnosable rather than just a verdict.

### Options

| flag | meaning |
|---|---|
| `--judge <path>` | module exporting the closure (required) |
| `--model <id>` | the id you will declare in config; the certificate is bound to it (required) |
| `--fixtures a.json,b.json` | your own pairs instead of the published sets |
| `--out <path>` | certificate path (default `gnl-judge-cert.json`) |
| `--concurrency <n>` | pairs in flight (default 4) |

## The bars, and where they come from

`paraphraseRecall >= 0.70` and `nearMissFp <= 0.05`, imported from `@gnldev/durable` so the bench
scores against the exact numbers the runtime enforces — one contract, not two copies that drift.

Recall is measured on **paraphrase pairs only**. Crediting `dup-exact` would let a judge that merely
recognises identical strings pass an exam about rewordings, and the deterministic layers already
catch those. The false-alarm bar is the harsher one on purpose: a question storm trains operators to
approve everything, which is how a real duplicate gets approved too.

An unparsed answer is **never credited**. At runtime it degrades to today's behavior, so scoring it
as a correct "different" would flatter a judge for staying silent.

## Your own fixtures

```json
{ "v": 1, "pairs": [
  { "id": "d1-dp-01", "toolName": "createOrder", "a": "Samsung 42 inch TV", "b": "SMSNG TV42",
    "label": "dup-paraphrase" }
]}
```

Labels: `dup-exact` and `dup-paraphrase` mean the same job; `near-miss` and `unrelated` mean
different jobs. `near-miss` is where the value lives — pairs that LOOK alike and are not (neighbouring
SKUs, sibling companies, adjacent sizes) are what separate a usable judge from a plausible one.

## Before you certify a judge: check you need one

Measured on 144 turns of natural conversation through the real engine, the judge was called twelve
times and asked nothing, because a competent tool model canonicalises identity for you — "one more of
that television" arrives as `sku: "TV-42"`, byte-identical to the earlier call, and the exact-hash
layer catches it long before a judge is consulted.

A judge earns its cost where the model passes text through as written: ticket subjects, customer and
company names, free-text descriptions. If your identity fields are codes the model normalises, read
`scan.grayCalls` in Studio first — a number near zero means the exam is not worth sitting yet.

## Honest limits

These belong next to the number they qualify:

- **The fixtures are synthetic.** They measure whether a judge can tell "same job, written
  differently" from "different job that looks alike". They cannot tell you how often either shape
  occurs in your system — live `precision@suspend` in Studio is the only answer to that, and it stays
  the release gate.
- **Twin brains — measured, not assumed.** The published pairs were generated by a model, so a judge
  from that same family might have found the phrasing easier. An open-weights model from an unrelated
  family sat the same exam and scored 93% recall / 4% false alarms, landing between the two
  same-family judges: if the advantage exists it is small. Still read a passing score as a floor on
  capability, not a promise of field accuracy.
- **A published held-out set is not held out.** The certificate stamps exam performance. Use
  `--fixtures` with your own domain pairs to measure something unseen.
- **The framework cannot verify the numbers were honestly measured** — it enforces that a
  certificate exists, matches your model and prompt version, and clears the bars. Skipping the exam
  is not an oversight you can fall into; it is an explicit declaration, and the journal records it.

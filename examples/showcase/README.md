# showcase

A self-verifying showcase that runs the packages **like a real consumer** (`file:` import). **No API key required** (deterministic mock model).

## Run
```bash
# build the packages first (file: links point to dist)
pnpm -r build   # from the repository root

pnpm install
pnpm demo      # prints each feature in order with ✓/✗; produces gnl-demo.db; ends with "N/N ✓"
pnpm studio    # http://localhost:4321 → time-travel + fork + approval queue (visual)
```

## What it proves
Every line is a real feature + assertion: at-most-once side effects (charge→crash→resume), PII redaction, schema working memory + tool, RAG + reranker, MCP client+server dedup, multi-agent handoff, suspend/resume, evented workflow (waitFor), durable queue, event bus with CAS ack marking, cross-network A2A, cross-run cache, evals (scoreRun + dataset), OTEL trace waterfall + cost, time-travel + fork, studio.

The `pnpm demo` output = proof that the packages work together **as installed, in a real consumer**.

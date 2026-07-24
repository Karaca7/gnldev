# gnl-demo

A self-verifying showcase that runs ALL 14 packages **like a real consumer** (`file:` import). **No API key required** (deterministic mock model).

## Run
```bash
# build the packages first (file: links point to dist)
cd ../gnl && pnpm -r build && cd ../gnl-demo

pnpm install
pnpm demo      # prints 16 features in order with ✓/✗; produces gnl-demo.db; ends with "N/N ✓"
pnpm studio    # http://localhost:4321 → time-travel + fork + approval queue (visual)
```

## What it proves
Every line is a real feature + assertion: exactly-once (charge→crash→resume), PII redaction, schema working memory + tool, RAG + reranker, MCP client+server exactly-once, multi-agent handoff, suspend/resume, evented workflow (waitFor), durable queue, exactly-once event bus, cross-network A2A, cross-run cache, evals (scoreRun + dataset), OTEL trace waterfall + cost, time-travel + fork, studio.

The `pnpm demo` output = proof that the packages work together **as installed, in a real consumer**.

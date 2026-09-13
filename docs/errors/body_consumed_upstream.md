# body_consumed_upstream

**HTTP 500**

## What happened

A body parser mounted AHEAD of the GNL handler already drained the request stream, so there was
nothing left for the handler to read. `express.json()`, `koa-bodyparser` and Fastify's built-in JSON
parser all do this. The handler detects it and says so instead of failing later with something
unrecognisable.

The signature is distinctive: every `GET` works and every `POST` with a body fails.

## Why

**It is reported rather than repaired.** Re-serialising the parsed `req.body` back into a stream
would make the common case work and quietly change the bytes — key order, unicode escaping — and do
nothing at all for multipart or a raw payload. Two things in this framework verify the bytes they
received: A2A signature verification and webhook-style signed bodies. A helpful re-serialisation
would break exactly those, on the day they matter, having worked for months.

**500 and not 400.** Nothing is wrong with the request. The mounting order of the server is wrong,
and that is the deployment's fault, not the caller's.

**Mount order is the ecosystem's answer too**, not a GNL quirk: better-auth's Node handler documents
the same constraint for the same reason.

## What to do

**Mount the GNL handler BEFORE the body parser.** Your own routes still get parsed bodies — the
parser continues to run for everything after it.

```js
app.all('/api/*', toNodeHandler(api));   // first
app.use(express.json());                 // then your parser, for your own routes
```

**On Fastify, bind at the middleware layer, not as a route.** `fastify.all('/api/*', …)` runs after
the built-in JSON parser has already drained the stream. Through `@fastify/middie` the same handler
runs before parsing and works.

**Do not scope the parser off the GNL path as a workaround** unless you have to — it looks equivalent
and drifts the first time somebody adds a route. Ordering is one line and stays true.

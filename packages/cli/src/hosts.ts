// The server a project will actually run on, and the file that binds GNL to it.
//
// `gnl init` used to ask only which FEATURES you want and to produce no server entry at all —
// development is served by `gnl dev`, which stands up its own listener, so nothing feels missing
// until the day you deploy and there is nothing to deploy. The recipes below close that: they are
// not written from the documentation, they are the ones measured against each running server, with
// the traps each one sets already avoided.
//
// Every recipe produces the SAME two files. `src/app.ts` is server-neutral (`export const app`) and
// is what edge targets and the managed runtime consume; `src/server.ts` is the only file that knows
// which HTTP framework you picked. Keeping them apart is what lets the choice be real without
// becoming a fork in the road.

/** Its own server file, or lines pasted into a server that already exists. */
export type HostMode = 'own' | 'mount';

export interface HostRecipe {
  id: string;
  label: string;
  hint: string;
  /** Added to the project's dependencies. The base template already carries hono + @hono/node-server. */
  deps?: Record<string, string>;
  /**
   * Type packages. `@types/node` is added for EVERY host, not per framework: a server entry reads
   * `process.env.PORT` and imports `node:http`, and the base template never needed either — it had
   * no server file. Without it the generated project does not typecheck, which is a bad first
   * impression from code we wrote.
   */
  devDeps?: Record<string, string>;
  /** `src/server.ts` — the "its own server" answer. */
  server: string;
  /**
   * The "mount into a server I already have" answer: the lines a reader pastes into THEIR server
   * file. Never written to disk as code — printed, and appended to the README — because the file it
   * belongs in is the user's, and the iron rule (init-answers.ts) forbids a generator forking that.
   *
   * Each one is the binding server-matrix actually measured for this host, including the trap that
   * host has: prefix stripping (node, koa), body parsers that drain the stream before the handler
   * (express, fastify, koa), and mount order (hono).
   */
  mount: string;
}

const APP_TS = `// The GNL surface, with no server attached.
//
// Kept separate from src/server.ts on purpose: this file is what runs on the edge (Workers, Vercel,
// Deno, Bun), none of which uses a Node HTTP framework. Your server choice lives next door and does
// not reach in here.
import { createGnl, toJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import type { CreateGnlConfig } from '@gnldev/durable';
import { createRestApi } from '@gnldev/server';
import { createStudioApp, createStudioRunner } from '@gnldev/studio';
import { aiToolSchema } from '@gnldev/studio/ai';
import raw from '../gnl.config.js';

// Widened to the declared type on purpose. gnl.config.ts is written with \`satisfies\`, so its inferred
// Type is the literal you wrote — a config with a storage has no \`journal\` PROPERTY at all, and
// Reading one is a compile error rather than \`undefined\`. The contract is the interface.
const config: CreateGnlConfig = raw;
const gnl = createGnl(config);

// A config carries EITHER a storage or a journal, and \`gnl dev\` resolves it the same way: the reader
// Comes from storage.runs when there is a storage, and from the config's own journal otherwise.
//
// The second branch is asserted rather than checked, and the assertion is worth understanding.
// Studio reads (listRuns/readRun); \`Journal\` only promises writes. Every journal shipped here also
// Reads, so the assertion holds in practice — but a hand-rolled write-only journal would compile
// And then serve an empty timeline. If that is your case, pass a reader explicitly.
const reader = config.storage
  ? toJournal(config.storage.runs)
  : (config.journal as unknown as Parameters<typeof createStudioApp>[0] extends { reader: infer R } ? R : never);

/** Role auth from gnl.config's \`auth\` (or GNL_ADMIN_TOKEN / GNL_VIEWER_TOKEN in the environment) —
 * the same resolution \`gnl dev\` applies. Without this the scaffold mounted Studio and the REST API
 * with NO auth at all, so \`gnl add host\` copied an unauthenticated admin surface into every
 * generated project; only NODE_ENV=production's fail-closed gate stood in the way. */
const cred = (v?: string) => (v ? { token: v } : undefined);
const roles = {
  admin: (raw as { auth?: { admin?: object } }).auth?.admin ?? cred(process.env.GNL_ADMIN_TOKEN),
  viewer: (raw as { auth?: { viewer?: object } }).auth?.viewer ?? cred(process.env.GNL_VIEWER_TOKEN),
};
const auth = roles.admin || roles.viewer ? roleAuth(roles as never) : undefined;

/** The REST API — agents, runs, workflows. A fetch handler: callable, and carrying \`.fetch\`. */
export const app = createRestApi(config, { title: 'app', auth });

// WHO IS EACH RUN FOR? This host answers it from the AUTHENTICATED principal: with \`auth\` above, the
// caller's identity becomes the run's \`resourceId\` — the key memory scopes on and the value every
// ownership gate compares against. Without \`auth\`, there is no principal, the subject can only come
// from \`body.resourceId\`, and a gate with no verified owner refuses nobody. The startup banner this
// file prints says which of the two you are in.
//
// The chat surface (@gnldev/chat-adapter) and AG-UI (@gnldev/agui) have no auth of their own and name
// the subject through an \`identity\` hook instead. That hook used to live here as a commented-out
// block — the most security-relevant function a host writes, in the one form that never compiles and
// never gets tested. It is a real file now: \`src/routes/chat.ts\`, written whenever this project has
// a server (\`gnl add chat\` otherwise).

/** The Studio inspector + playground. Mount it in development; gate it or drop it in production. */
export const studio = createStudioApp({
  reader,
  apiBase: '/studio',
  gnl: createStudioRunner(gnl, config, { toJsonSchema: aiToolSchema }),
  auth,
});
`;

/** The header every generated server file carries — the one rule this package asks of a host. */
const RULE = `// Two rules, both measured on a live server rather than reasoned about:
//
//   1. Bind at the MIDDLEWARE layer, never as a route. On Fastify this is the whole difference:
//      Middleware runs before body parsing, a route runs after it.
//   2. Mount BEFORE whatever parses request bodies. A parser that runs first reads the stream to the
//      End and hands the result to the framework, not to us; the handler then sees a POST with no
//      Body. Your own routes keep the parser — it still runs for everything mounted after.
`;

export const HOSTS: HostRecipe[] = [
  {
    id: 'hono',
    label: 'Hono',
    hint: 'no bridge, fewest moving parts',
    mount: `import { app as gnlApi, studio } from './app.js';
import { chat } from './routes/chat.js';

// \`mount()\` registers ONE blanket wildcard per call, so the specific path goes first — a '/' mount
// registered before '/studio' swallows it.
yourApp.mount('/studio', studio);
yourApp.route('/api', chat);     // a Hono app, so route() — mount() is for fetch handlers
// useChat({ api: '/api/agents/assistant/chat' })
yourApp.mount('/gnl', gnlApi);
`,
    server: `// Hono — the one host that needs no bridge at all: the factories hand out a fetch handler and
// Hono mounts it directly.
//
// MOUNT ORDER. \`app.mount()\` registers a single blanket wildcard per call, unlike \`route()\`, so a
// Catch-all at '/' swallows everything mounted after it. Specific paths first.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { app as api, studio } from './app.js';
import { chat } from './routes/chat.js';

const server = new Hono();
server.mount('/studio', studio);
server.route('/api', chat);   // a Hono app, so route() — mount() is for fetch handlers
// useChat({ api: '/api/agents/assistant/chat' })
server.mount('/', api);

// Loopback by default — set HOST=0.0.0.0 to reach it from outside (containers). A bare listen
// binds every interface, which for a Studio without auth is an admin surface offered to the network.
serve({ fetch: server.fetch, port: Number(process.env.PORT ?? 3000), hostname: process.env.HOST ?? '127.0.0.1' });
console.log('→ http://localhost:' + (process.env.PORT ?? 3000) + '/studio');
`,
  },
  {
    id: 'node',
    label: 'node:http',
    hint: 'no framework, no dependency',
    mount: `import { toNodeHandler } from '@gnldev/server/node';
import { app as gnlApi, studio } from './app.js';
import { chat } from './routes/chat.js';

const studioNode = toNodeHandler(studio as never);
const apiNode = toNodeHandler(gnlApi);

// Inside your existing request handler. Nothing strips the prefix for you here — that is what
// distinguishes bare node:http from Express.
if (req.url?.startsWith('/studio')) {
  req.url = req.url.slice('/studio'.length) || '/';
  return studioNode(req, res);
}
if (req.url?.startsWith('/api')) {              // useChat({ api: '/api/agents/assistant/chat' })
  req.url = req.url.slice('/api'.length) || '/';
  return toNodeHandler(chat as never)(req, res);
}
if (req.url?.startsWith('/gnl')) {
  req.url = req.url.slice('/gnl'.length) || '/';
  return apiNode(req, res);
}
`,
    server: `// Bare node:http — no router, so the prefix is stripped by hand. Nothing else strips it for you.
import { createServer } from 'node:http';
import { toNodeHandler } from '@gnldev/server/node';
import { app as api, studio } from './app.js';
import { chat } from './routes/chat.js';

const studioNode = toNodeHandler(studio as never);
// The OBJECT, not its \`.fetch\` — \`toNodeHandler\` reads \`.fetch\` off what it is given, so passing
// the function produced a handler that looked for \`fetch.fetch\` and answered 500 to every chat
// request. Measured against a real Express app; the API and Studio lines above are the same shape.
// \`as never\` because Hono types \`fetch\` with optional Workers parameters this bridge does not name.
const chatNode = toNodeHandler(chat as never);
const apiNode = toNodeHandler(api);

const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => {
  if (req.url?.startsWith('/studio')) {
    req.url = req.url.slice('/studio'.length) || '/';
    return studioNode(req, res);
  }
  if (req.url?.startsWith('/api')) {           // useChat({ api: '/api/agents/assistant/chat' })
    req.url = req.url.slice('/api'.length) || '/';
    return chatNode(req, res);
  }
  return apiNode(req, res);
}).listen(port, process.env.HOST ?? '127.0.0.1'); // loopback by default — HOST=0.0.0.0 for containers
console.log('→ http://localhost:' + port + '/studio');
`,
  },
  {
    id: 'express',
    label: 'Express',
    hint: 'the widest middleware ecosystem',
    deps: { express: '^5.1.0' },
    devDeps: { '@types/express': '^5.0.0' },
    mount: `import { toNodeHandler } from '@gnldev/server/node';
import { app as gnlApi, studio } from './app.js';
import { chat } from './routes/chat.js';

// BEFORE any global \`express.json()\`. A body parser mounted ahead of these drains the request
// stream, and GNL then answers "runId is required" to a request that carried one.
yourApp.use('/studio', toNodeHandler(studio as never));
yourApp.use('/api', toNodeHandler(chat as never));     // useChat({ api: '/api/agents/assistant/chat' })
yourApp.use('/gnl', toNodeHandler(gnlApi));
// Express strips the mount prefix from req.url before the handler runs — do not add it back.
`,
    server: `${RULE}//
// Express strips the mount prefix from \`req.url\` before the handler runs — do NOT add it back, or
// Every path 404s while looking like the package is broken.
import express from 'express';
import { toNodeHandler } from '@gnldev/server/node';
import { app as api, studio } from './app.js';
import { chat } from './routes/chat.js';

const server = express();

// Your own routes first, with the body parser scoped to them. A GLOBAL \`express.json()\` ahead of
// GNL is the misconfiguration that answers "runId is required" to a request that carried one.
// server.use('/app', express.json(), yourRouter);

server.use('/studio', toNodeHandler(studio as never));
server.use('/api', toNodeHandler(chat as never));   // useChat({ api: '/api/agents/assistant/chat' })
server.use('/', toNodeHandler(api));

const port = Number(process.env.PORT ?? 3000);
server.listen(port, process.env.HOST ?? '127.0.0.1'); // loopback by default — HOST=0.0.0.0 for containers
console.log('→ http://localhost:' + port + '/studio');
`,
  },
  {
    id: 'fastify',
    label: 'Fastify',
    hint: 'via @fastify/middie',
    deps: { fastify: '^5.2.0', '@fastify/middie': '^9.3.3' },
    mount: `import middie from '@fastify/middie';
import { toNodeHandler } from '@gnldev/server/node';
import { app as gnlApi, studio } from './app.js';
import { chat } from './routes/chat.js';

// \`register(middie)\` is what makes this Express's recipe line for line. Binding as a Fastify ROUTE
// instead runs after its JSON parser has drained the stream: every GET passes, every POST 400s.
await yourApp.register(middie);
yourApp.use('/studio', toNodeHandler(studio as never));
yourApp.use('/api', toNodeHandler(chat as never));     // useChat({ api: '/api/agents/assistant/chat' })
yourApp.use('/gnl', toNodeHandler(gnlApi));
`,
    server: `${RULE}//
// \`register(middie)\` is what makes this Express's recipe line for line. Binding as a route instead —
// \`app.all('/studio/*', …)\` — runs AFTER Fastify's built-in JSON parser has drained the stream: every
// GET passes and a POST with a body answers 400. Forgetting middie throws immediately
// (\`app.use is not a function\`), which is the good kind of failure.
import Fastify from 'fastify';
import middie from '@fastify/middie';
import { toNodeHandler } from '@gnldev/server/node';
import { app as api, studio } from './app.js';
import { chat } from './routes/chat.js';

const server = Fastify();
await server.register(middie);

server.use('/api', toNodeHandler(chat as never));   // useChat({ api: '/api/agents/assistant/chat' })

// Your own routes are Fastify routes — they keep its parser, its validation, its 404.
// server.get('/app/health', async () => ({ ok: true }));

const apiNode = toNodeHandler(api);
server.use('/studio', toNodeHandler(studio as never));
// Middleware runs BEFORE routes in Fastify, so let paths you own fall through with next().
server.use((req: { url?: string }, res: unknown, next: () => void) =>
  (String(req.url).startsWith('/app/') ? next() : apiNode(req as never, res as never)));

const port = Number(process.env.PORT ?? 3000);
await server.listen({ port, host: process.env.HOST ?? '127.0.0.1' }); // loopback by default — HOST=0.0.0.0 for containers
console.log('→ http://localhost:' + port + '/studio');
`,
  },
  {
    id: 'koa',
    label: 'Koa',
    hint: 'via koa-connect',
    deps: { koa: '^2.16.0', 'koa-connect': '^2.1.0' },
    devDeps: { '@types/koa': '^2.15.0' },
    mount: `import c2k from 'koa-connect';
import { toNodeHandler } from '@gnldev/server/node';
import { app as gnlApi, studio } from './app.js';
import { chat } from './routes/chat.js';

const studioNode = toNodeHandler(studio as never);
const apiNode = toNodeHandler(gnlApi);

// FIRST in the chain, and \`next\` must be NAMED: koa-connect switches on fn.length, and below three
// parameters it assumes the middleware did not answer — Koa then writes its own 404 over the
// response already sent. Koa does not strip the prefix either.
yourApp.use(c2k((req: { url?: string }, res: unknown, _next: () => void) => {
  const url = String(req.url);
  if (url.startsWith('/studio')) {
    (req as { url: string }).url = url.slice('/studio'.length) || '/';
    return studioNode(req as never, res as never);
  }
  if (url.startsWith('/api')) {                 // useChat({ api: '/api/agents/assistant/chat' })
    (req as { url: string }).url = url.slice('/api'.length) || '/';
    return toNodeHandler(chat as never)(req as never, res as never);
  }
  if (url.startsWith('/gnl')) {
    (req as { url: string }).url = url.slice('/gnl'.length) || '/';
    return apiNode(req as never, res as never);
  }
  return _next();
}));
// Your own parser and routes go AFTER this, and only see what it let through.
`,
    server: `${RULE}//
// THREE parameters, and the third is never called. \`koa-connect\` switches on \`fn.length\`: below
// Three it assumes the middleware does not terminate the response, calls next() straight after, and
// Koa writes its own 404 over what was already sent — measured, 404 on every route with
// ERR_HTTP_HEADERS_SENT. Naming \`next\` selects the branch that waits.
//
// Being FIRST in the chain is also what saves the request body: Koa's parser is just another
// Middleware, and mounted after us it never sees our requests.
import Koa from 'koa';
import c2k from 'koa-connect';
import { toNodeHandler } from '@gnldev/server/node';
import { app as api, studio } from './app.js';
import { chat } from './routes/chat.js';

const studioNode = toNodeHandler(studio as never);
// The OBJECT, not its \`.fetch\` — \`toNodeHandler\` reads \`.fetch\` off what it is given, so passing
// the function produced a handler that looked for \`fetch.fetch\` and answered 500 to every chat
// request. Measured against a real Express app; the API and Studio lines above are the same shape.
// \`as never\` because Hono types \`fetch\` with optional Workers parameters this bridge does not name.
const chatNode = toNodeHandler(chat as never);
const apiNode = toNodeHandler(api);
const server = new Koa();

server.use(c2k((req: { url?: string }, res: unknown, _next: () => void) => {
  const url = String(req.url);
  if (url.startsWith('/studio')) {
    // Koa does not strip the mount prefix — unlike Express, which does.
    (req as { url: string }).url = url.slice('/studio'.length) || '/';
    return studioNode(req as never, res as never);
  }
  if (url.startsWith('/api')) {                // useChat({ api: '/api/agents/assistant/chat' })
    (req as { url: string }).url = url.slice('/api'.length) || '/';
    return chatNode(req as never, res as never);
  }
  return apiNode(req as never, res as never);
}));

// Your own parser and routes go AFTER, and only see what the block above let through.
// server.use(bodyParser());

const port = Number(process.env.PORT ?? 3000);
server.listen(port, process.env.HOST ?? '127.0.0.1'); // loopback by default — HOST=0.0.0.0 for containers
console.log('→ http://localhost:' + port + '/studio');
`,
  },
  {
    id: 'nest',
    label: 'NestJS',
    hint: 'Express or Fastify platform — both work unchanged',
    deps: { '@nestjs/common': '^11.0.0', '@nestjs/core': '^11.0.0', '@nestjs/platform-express': '^11.0.0', 'reflect-metadata': '^0.2.2', rxjs: '^7.8.1' },
    mount: `import { toNodeHandler } from '@gnldev/server/node';
import { app as gnlApi, studio } from './app.js';
import { chat } from './routes/chat.js';

// Nothing Nest-specific is needed on either platform: \`app.use()\` reaches the middleware chain
// underneath. Measured on both @nestjs/platform-express and @nestjs/platform-fastify.
yourApp.use('/studio', toNodeHandler(studio as never));
yourApp.use('/gnl', toNodeHandler(gnlApi));
`,
    server: `${RULE}//
// Nest needs nothing Nest-specific, on either platform: \`app.use()\` reaches the middleware chain
// Underneath and the bridge does the rest. Measured on both @nestjs/platform-express and
// @nestjs/platform-fastify.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { toNodeHandler } from '@gnldev/server/node';
import { app as api, studio } from './app.js';
import { chat } from './routes/chat.js';

@Module({ controllers: [], providers: [] })
class AppModule {}

const server = await NestFactory.create(AppModule);
const apiNode = toNodeHandler(api);
server.use('/studio', toNodeHandler(studio as never));
server.use('/api', toNodeHandler(chat as never));   // useChat({ api: '/api/agents/assistant/chat' })
// Let your own controllers' paths fall through; everything else is the API's.
server.use((req: { url?: string }, res: unknown, next: () => void) =>
  (String(req.url).startsWith('/app/') ? next() : apiNode(req as never, res as never)));

const port = Number(process.env.PORT ?? 3000);
await server.listen(port, process.env.HOST ?? '127.0.0.1'); // loopback by default — HOST=0.0.0.0 for containers
console.log('→ http://localhost:' + port + '/studio');
`,
  },
];

export const HOST_IDS: readonly string[] = HOSTS.map((h) => h.id);

/**
 * The server-neutral half — written whenever a host is chosen.
 *
 * Typed `string` on purpose, not left to inference: as a literal type this template's ENTIRE text
 * lands in `hosts.d.ts`, and its text contains `import … from '@gnldev/auth'`. Anything that pulls
 * this module into the root entry's type graph then reads as the package dragging an optional peer
 * into consumers' types.
 */
export const APP_FILE: string = APP_TS;

export function hostById(id: string): HostRecipe | undefined {
  return HOSTS.find((h) => h.id === id);
}

/**
 * The paragraph appended to the project README.
 *
 * Asking "which server?" is a promise, and the promise does not hold everywhere — so the answer says
 * where it does. A user who picks Fastify, deploys to the managed cloud and finds their choice
 * ignored was mis-sold by the question, not by the platform.
 */
export function hostReadme(host: HostRecipe, mode: HostMode = 'own'): string {
  if (mode === 'mount') {
    return [
      '',
      '## Mounting into your server',
      '',
      `\`src/app.ts\` is the GNL surface with no server attached. Paste this into your **${host.label}**`,
      'server — the file is yours, so nothing generated it for you:',
      '',
      '```ts',
      host.mount.trimEnd(),
      '```',
      '',
      '`gnl dev` keeps working while you build; it serves the same surface on its own port.',
      '',
    ].join('\n');
  }
  return [
    '',
    `## Running it`,
    '',
    `\`src/server.ts\` binds this project to **${host.label}**. \`src/app.ts\` is the same surface with no`,
    'server attached — that is the half the other two deployment paths use.',
    '',
    '```',
    'npx tsx src/server.ts     # your own server, your own host',
    'gnl dev                   # development: REST + Studio on one port, no server file involved',
    '```',
    '',
    '**Where the choice applies.** On your own machine, VPS, container or any Node host — entirely:',
    'the file above is what runs. On **edge targets** (Workers, Vercel, Netlify, Deno, Bun) no Node',
    'framework runs at all — `src/app.ts` is exported directly, because createRestApi() returns a',
    'web-standard fetch handler and that is all those platforms need.',
    '',
  ].join('\n');
}

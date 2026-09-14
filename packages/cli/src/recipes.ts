import { randomBytes } from 'node:crypto';
// Shared feature recipes — the single source used by BOTH `gnl add <feature>` (writes the src file +
// prints hand-wiring) and `gnl init` feature-composition (writes the src file + GENERATES gnl.config.ts).
//
// Each recipe is a real, type-correct src file against the current package APIs (@gnldev/rag,
// @gnldev/memory, @gnldev/mcp, @gnldev/workflow, @gnldev/auth, @gnldev/durable) plus a structured `wiring` describing
// how it slots into the decoupled gnl.config.ts (agentTool → an agent's `tools`; configField → a
// top-level config property). `humanWire` is the corrected instruction `gnl add` prints (the config is
// decoupled now — NO `defineConfig({ … })`; you edit the plain config object).

/** Where a recipe's export slots into the generated gnl.config.ts. */
export type WiringPlace = 'agentTool' | 'configField';

/**
 * Resolves a recipe's contents, whether static, generated, or COMPOSED FROM PARTS.
 *
 * `picked` is only meaningful for a recipe that declares `variants` — the guards file is the one
 * that does. Passing it to a recipe without variants is harmless: those generators ignore it.
 */
export function recipeContents(r: Recipe, picked?: readonly string[]): string {
  return typeof r.contents === 'function' ? r.contents(picked) : r.contents;
}

/** The default `picked` for a variant recipe: everything marked `default`. */
export function defaultVariants(r: Recipe): string[] {
  return (r.variants ?? []).filter((v) => v.default).map((v) => v.id);
}

export interface VariantOption {
  id: string;
  label: string;
  hint?: string;
  /** Checked when the list opens, and the set a non-interactive run gets. */
  default?: boolean;
}

/**
 * A per-project development token. Random, so it is never a value anyone can look up in this
 * package's published source — which is what `admin-dev` was.
 */
function devToken(role: string): string {
  return `${role}-${randomBytes(9).toString('base64url')}`;
}

export interface RecipeWiring {
  /** The import line to add to gnl.config.ts, e.g. "import { searchDocs } from './src/tools/rag.js';". */
  import: string;
  place: WiringPlace;
  /** agentTool → an entry inside an agent's `tools: { … }` (e.g. `searchDocs`, or a spread `...mcpToolset`).
   *  configField → a top-level config property (e.g. `memoryFactory`, `workflows: { checkout }`). */
  code: string;
}

export interface Recipe {
  id: string;
  /** Label shown in the `gnl init` checkbox. */
  label: string;
  /** Extra inline hint shown after the label (e.g. "(GNL's edge)"). */
  hint?: string;
  /** Relative path written into the project (never overwritten by `add`). */
  file: string;
  /** File body. */
  /**
   * The file to write. A FUNCTION when the content must differ per project — the auth recipe
   * generates a random dev token, because a literal in this file is a literal in the npm tarball,
   * and an admin API guarded by a published string is not guarded.
   */
  contents: string | ((picked?: readonly string[]) => string);
  /**
   * Parts a caller can choose between, instead of one fixed file.
   *
   * Exactly one recipe has these today, and the reason is specific to it: the guards file is a LIST,
   * and a list is the one shape where "here is everything, delete what you do not want" is worse
   * than asking — an unwanted guard that ships enabled is a behaviour change nobody chose, and one
   * that ships commented out teaches people to skim past commented code. Recipes whose output is a
   * single wired thing (a tool, a route, a worker) stay fixed.
   */
  variants?: VariantOption[];
  /** npm dependency to add to package.json (omit if already in the base template — e.g. memory/auth). */
  dep?: string;
  /**
   * A package.json script this recipe brings with it, for the recipes whose output is a PROCESS
   * rather than a config line — a queue worker and a scheduler poller are long-running loops, not
   * things `gnl dev` mounts. Without this they would be files nobody has a way to start.
   */
  script?: { name: string; cmd: string };
  /** How this recipe wires into gnl.config.ts (omit → nothing to wire, file is self-contained). */
  wiring: RecipeWiring;
  /** The corrected instruction `gnl add` prints (decoupled: edit the config object, NOT defineConfig). */
  humanWire: string;
  /** Honesty note about maturity / required setup, if any. */
  note?: string;
  /**
   * Environment variables this recipe's file reads, as `NAME=hint` lines. `gnl add` writes them into
   * `.env.example` — the file the scaffold's .gitignore already carves an exception for (`!.env.example`)
   * and that nothing ever created, so the exception described a file that never existed.
   */
  env?: string[];
  /** When the wired field lives on the dev-server config (GnlDevConfig) rather than CreateGnlConfig,
   *  the generated `satisfies` clause must be widened with this type literal (e.g. auth). */
  configTypeExt?: string;
}

export const RECIPES: Record<string, Recipe> = {
  'idempotency-tool': {
    id: 'idempotency-tool',
    label: 'Idempotent charge tool',
    hint: "GNL's edge",
    file: 'src/tools/charge-order.ts',
    // THIS FILE USED TO EXIST TWICE — here, and as `templates/full/src/tools.ts`. The duplication was
    // held together by a comment saying "kept in sync", which is a promise that cannot notice being
    // broken: a sentence-capitaliser walked this literal and left `// IdempotencyWindow:` where the
    // template still said `idempotencyWindow`, so one of the two copies told you to uncomment a line
    // that does not compile. A test replaced the promise, and then the second copy was retired
    // altogether (see scaffold.ts's RETIRED_TEMPLATES) — this is now the only one.
    contents: `// A side-effecting durable tool that showcases GNL's edge: LLM-aware idempotency.
//
// \`idempotency: 'args'\` keys the journal by the tool's ARGUMENTS instead of the AI SDK's
// per-call \`toolCallId\`. So even when the model re-plans the same call under a brand-new
// \`toolCallId\` — the dominant real-world double-charge case (a documented AI SDK pattern) — the tool
// runs exactly once and every duplicate gets the journaled result. \`idempotencyKey\` narrows
// the dedup to a logical key (here: \`orderId\`), so two calls with the same orderId but
// otherwise different args still collapse to one execution.

// A stand-in "ledger" so the demo/e2e can observe how many times the side effect really ran.
// In a real app this would be a DB write / a Stripe charge / an email send.
export const ledger: { charges: { orderId: string; amount: number }[] } = { charges: [] };

export const chargeOrder = {
  description: 'Charge a customer order (has a real side effect — must run exactly once).',
  idempotency: 'args' as const,
  idempotencyKey: (args: any) => String(args.orderId),
  // Uncomment to dedup across runs too (retried jobs / re-triggered agents):
  // idempotencyWindow: 'cross-run' as const,
  execute: async ({ orderId, amount }: { orderId: string; amount: number }) => {
    ledger.charges.push({ orderId, amount });
    return { charged: amount, orderId, receipt: \`rcpt_\${orderId}\` };
  },
};
`,
    wiring: {
      import: "import { chargeOrder } from './src/tools/charge-order.js';",
      place: 'agentTool',
      code: 'chargeOrder',
    },
    humanWire: `import { chargeOrder } from './src/tools/charge-order.js';
// …then add it to an agent's tools inside the config object:
  agents: { assistant: { ...assistant, tools: { chargeOrder } } }`,
    note: "GNL's edge: this tool is never silently run twice, even when the model re-emits the same call under a new toolCallId (a documented AI SDK pattern). "
      + '`gnl add` does not touch your agents — your own model has to actually call it. (A fresh scaffold '
      + 'ships this tool wired to a `charge-demo` agent whose mock model does, plus test/proof.test.ts.)',
  },

  rag: {
    id: 'rag',
    label: 'RAG (retrieval tool)',
    file: 'src/tools/rag.ts',
    dep: '@gnldev/rag',
    contents: `// Retrieval-augmented generation: an in-memory vector store + a tool the agent can call.
// Swap InMemoryVectorStore for PostgresVectorStore in production.
import { InMemoryVectorStore, indexDocuments, createRagTool } from '@gnldev/rag';

// A trivial deterministic embed so this runs with no API key. Replace with a real embedder.
const embed = async (text: string): Promise<number[]> =>
  Array.from({ length: 8 }, (_, i) => (text.charCodeAt(i) || 0) / 255);

export const store = new InMemoryVectorStore();

// Seed the store at import time (top-level await) so \`searchDocs\` has something to find.
await indexDocuments(store, embed, [
  { id: 'doc-1', text: 'GNL charges every order exactly once, even under duplicate tool-calls.' },
]);

export const searchDocs = createRagTool({ store, embed, topK: 3 });
`,
    wiring: {
      import: "import { searchDocs } from './src/tools/rag.js';",
      place: 'agentTool',
      code: 'searchDocs',
    },
    humanWire: `import { searchDocs } from './src/tools/rag.js';
// …then add it to an agent's tools inside the config object:
  agents: { assistant: { ...assistant, tools: { searchDocs } } }`,
  },

  mcp: {
    id: 'mcp',
    label: 'MCP tools',
    file: 'src/tools/mcp.ts',
    dep: '@gnldev/mcp',
    contents: `// Connect an MCP server and expose its tools to your agent.
// \`mcpTools(...)\` opens no connection until \`.tools()\` is called; we resolve the toolset here (top-level
// await) so it can be spread into an agent's \`tools\`. Until you point it at a real server this is empty,
// so the app still boots — replace the export below with the two commented lines once you have one.
import { mcpTools } from '@gnldev/mcp';
import type { ToolSet } from 'ai';

// const handle = mcpTools({ transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } });
// export const mcpToolset: ToolSet = await handle.tools();
export const mcpToolset: ToolSet = {};
`,
    wiring: {
      import: "import { mcpToolset } from './src/tools/mcp.js';",
      place: 'agentTool',
      code: '...mcpToolset',
    },
    humanWire: `import { mcpToolset } from './src/tools/mcp.js';
// …then merge it into an agent's tools inside the config object:
  agents: { assistant: { ...assistant, tools: { ...mcpToolset } } }`,
    note: 'Fill in the MCP transport (stdio command/args or http url) in src/mcp.ts before using — the stub exports an empty toolset.',
  },

  memory: {
    id: 'memory',
    label: 'Conversation memory',
    file: 'src/memory.ts',
    // @gnldev/memory is already a dependency of the base template — no dep to add.
    contents: `// Conversation memory (threads + recall) for the Playground. Derived from the config's storage.
import { AgentMemory } from '@gnldev/memory';
import type { Storage, CreateGnlConfig } from '@gnldev/durable';

// MemoryFactory receives the config's storage (or journal). AgentMemory needs a Storage with the
// \`memory\` capability — SqliteStorage (the default in gnl.config.ts) has it.
export const memoryFactory: NonNullable<CreateGnlConfig['memoryFactory']> = (storage) =>
  new AgentMemory({ storage: storage as Storage });
`,
    wiring: {
      import: "import { memoryFactory } from './src/memory.js';",
      place: 'configField',
      code: 'memoryFactory',
    },
    humanWire: `import { memoryFactory } from './src/memory.js';
// …then add to the config object (top level):
  memoryFactory,   // Playground conversations are persisted + recalled per thread`,
  },

  workflow: {
    id: 'workflow',
    label: 'Durable workflow',
    file: 'src/workflows/checkout.ts',
    dep: '@gnldev/workflow',
    contents: `// A durable multi-step workflow. Each step is journaled → resumes from where it crashed.
// Appears in Studio → Workflows (list + run).
import { workflow, step } from '@gnldev/workflow';

export const checkout = workflow<{ orderId?: string }>()
  .then(step('reserve', async (i: any) => ({ ...i, reserved: true })))
  .then(step('charge', async (i: any) => ({ ...i, charged: 42 })))
  .then(step('confirm', async (i: any) => ({ ...i, ok: true })));
`,
    wiring: {
      import: "import { checkout } from './src/workflows/checkout.js';",
      place: 'configField',
      code: 'workflows: { checkout }',
    },
    humanWire: `import { checkout } from './src/workflows/checkout.js';
// …then add to the config object (top level):
  workflows: { checkout },   // appears in Studio → Workflows (list + run)`,
  },

  auth: {
    id: 'auth',
    label: 'Role-based auth',
    file: 'src/auth.ts',
    // @gnldev/auth is already a dependency of the base template — no dep to add.
    // Generated, not literal. The previous version wrote `admin-dev`/`viewer-dev` — which meant the
    // working admin credential for every scaffolded project was published in the npm tarball of this
    // package. The production guard below did not close it: outside production `gnl dev --host
    // 0.0.0.0` bound to every interface, printed "(auth: protected)", and accepted `Bearer admin-dev`
    // as full admin. Now each project gets its own value at scaffold time, so there is nothing
    // shared to look up.
    contents: () => `// Role-based auth for the REST API + Studio (admin = read/write, viewer = read).
// Provide credentials only — the dev server calls roleAuth() for you. Omit \`auth\` → the API stays open.
import type { Cred } from '@gnldev/auth';

// The dev fallbacks below were generated when this file was created and are unique to this project.
// They are convenience for local work ONLY: they sit in your source tree, so treat them as public.
// In production the process refuses to start without real tokens from the environment.
function credential(envVar: string, devFallback: string): string {
  const value = process.env[envVar];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(\`\${envVar} is not set — refusing to start with the development default.\`);
  }
  return devFallback;
}

export const auth: { admin?: Cred; viewer?: Cred } = {
  admin: { token: credential('GNL_ADMIN_TOKEN', '${devToken('admin')}') },
  viewer: { token: credential('GNL_VIEWER_TOKEN', '${devToken('viewer')}') },
};
`,
    wiring: {
      import: "import { auth } from './src/auth.js';",
      place: 'configField',
      code: 'auth',
    },
    configTypeExt: '{ auth?: { admin?: { token?: string }; viewer?: { token?: string } } }',
    humanWire: `import { auth } from './src/auth.js';
// …then add to the config object (top level):
  auth,   // { admin: { token }, viewer: { token } } — omit to keep the API open`,
    note: 'Free tier = token/role auth (JWT via @gnldev/auth). SSO (Auth0/WorkOS), RBAC and user management are in the paid @gnldev/auth-ee.',
  },
  schedule: {
    id: 'schedule',
    label: 'Scheduled workflows',
    hint: 'cron / interval',
    file: 'src/schedules/index.ts',
    dep: '@gnldev/scheduler',
    script: { name: 'schedules', cmd: 'tsx src/schedules/index.ts' },
    contents: `// Triggers, and the loop that fires them. A SEPARATE PROCESS from your API: \`pnpm schedules\`.
//
// Time is data here, not a timer. The next fire is resolved once and frozen into the journal, so a
// worker that wakes up late fires the run it owed instead of silently skipping it — and a replay
// sees the same schedule the original run saw.
//
// Several of these can run at once. A run lock picks one winner per fire and every write to the
// trigger's state is CAS-fenced, so a slot is never double-advanced.
import { createGnl } from '@gnldev/durable';
import { scheduleWorkflow, createScheduler } from '@gnldev/scheduler';
import config from '../../gnl.config.js';

const gnl = createGnl(config);
const journal = config.storage!.runs;

// REGISTERING IS IDEMPOTENT: the same id updates the definition instead of adding a second trigger,
// so this file can run on every deploy. \`name\` is a workflow in gnl.config.ts (\`gnl add workflow\`).
await scheduleWorkflow(journal, {
  id: 'nightly-report',
  cron: '0 3 * * *',        // 5-field cron, UTC, minute resolution
  name: 'checkout',         // ← the workflow to run
  // every: 60 * 60_000,    // …or an interval, in ms
  // at: Date.now() + 60_000, // …or a one-shot
});

const scheduler = createScheduler(journal, gnl, { pollMs: 30_000 });
scheduler.start();
console.log('→ scheduler polling every 30s');
`,
    wiring: {
      // Nothing to wire into gnl.config.ts: this file READS the config and runs beside the app.
      import: '',
      place: 'configField',
      code: '',
    },
    humanWire: `Nothing to add to gnl.config.ts — this runs as its own process:
  pnpm schedules
The workflow it fires must exist in your config (\`gnl add workflow\` writes one).`,
    note: 'A busy run is deferred, not failed: if the workflow is already running under that id the trigger waits for `retryMs` and keeps its attempt budget. Watch `deferrals` on listTriggers() — climbing deferrals with a flat fireCount means it is being refused, not waiting.',
  },

  job: {
    id: 'job',
    label: 'Background jobs',
    hint: 'durable queue + worker',
    file: 'src/jobs/index.ts',
    dep: '@gnldev/queue',
    script: { name: 'worker', cmd: 'tsx src/jobs/index.ts' },
    contents: `// A durable job queue and the worker that drains it. A SEPARATE PROCESS: \`pnpm worker\`.
//
// WHY A JOB IS A RUN. A bare \`await sendEmail(...)\` in a handler is AT-LEAST-once: a crash after the
// send but before the job is acked reclaims the lock and calls the handler again. Route the work
// through \`runDurable\` with the runId the context hands you, and the send happens once — the same
// journal, the same guarantee your agents get.
import { createGnl } from '@gnldev/durable';
import { enqueue, createWorker } from '@gnldev/queue';
import config from '../../gnl.config.js';

const storage = config.storage!;
const gnl = createGnl(config);

const worker = createWorker(storage, {
  // One entry per job type. \`ctx.runId\` is 'job:<jobId>' — stable across retries, which is what
  // makes the work inside it replay instead of repeat. Calling the agent BY NAME (rather than
  // assembling a runDurable call here) is what keeps the job on the same profile, tools and
  // protections the rest of the project has; a second assembly is a second set of defaults.
  summarize: async (payload: { text: string }, ctx: { runId: string }) =>
    gnl.run('assistant', {
      runId: ctx.runId,
      prompt: \`Summarize in one sentence: \${payload.text}\`,
    }),
});

worker.start();
console.log('→ worker draining the queue');

// PRODUCING, from anywhere that can reach the same storage (your API, a route, another job):
//
//   import { enqueue } from '@gnldev/queue';
//   await enqueue(storage.work, 'summarize', { text }, { id: \`summary:\${docId}\` });
//
// The \`id\` is what makes enqueue idempotent: the same id enqueues one job, however many times the
// request arrives. Leave it out and a double-click is two jobs.
void enqueue;
`,
    wiring: { import: '', place: 'configField', code: '' },
    humanWire: `Nothing to add to gnl.config.ts — this runs as its own process:
  pnpm worker
Produce jobs with \`enqueue(storage.work, 'summarize', payload, { id })\` from anywhere.`,
    note: 'A handler that throws is retried with backoff and dead-lettered after `maxAttempts` (default 5); Studio lists dead letters and can release them back. Give every enqueue a stable `id` — that is what makes producing idempotent.',
  },

  chat: {
    id: 'chat',
    label: 'Chat route',
    hint: 'useChat-compatible',
    file: 'src/routes/chat.ts',
    dep: '@gnldev/chat-adapter',
    // WHY THIS IS A FILE AND NOT A COMMENT. It was a comment: `src/app.ts` carried this whole block
    // commented out, including the identity resolver — the single most security-relevant function a
    // host writes. A commented resolver compiles never, is tested never, and is copied by hand into
    // the one place a typo means "runs are born owned by whoever asked". Now it is code.
    contents: `// The chat surface: the Vercel AI SDK's \`useChat\` talks to this route unchanged, while the run
// behind it is journaled, replayable, and its side effects are at-most-once.
//
// One durable run PER TURN. The route derives it from the conversation id + the last message id, so
// a network retry of the same turn replays instead of running twice — and when a subject is known
// (below), that derived string is promoted to a \`workKey\` and the engine mints the run id itself.
import { createChatRoute } from '@gnldev/chat-adapter';
import config from '../../gnl.config.js';

export const chat = createChatRoute(config, {
  // WHO IS THIS REQUEST ACTING FOR?
  //
  // Returning \`undefined\` is the honest default: runs are born with no owner, ownership gates have
  // nothing to compare against, and the protections matrix prints \`○ identity\` rather than pretending.
  // Nothing is forged either way — the route always seals the context, so a caller cannot name
  // themselves through the body.
  //
  // TODO, the day you have users: return \`{ resourceId }\` from something the SERVER established —
  // a session cookie you verified, a JWT whose signature you checked, \`principalOf(req)?.id\`.
  //
  //     // NEVER: const resourceId = (await req.json()).resourceId;
  //
  // A subject read out of the request body is the caller naming whoever they like.
  //
  // If you ran \`gnl init --identity end-users\`, that resolver is already written for you:
  //     import { identity } from '../identity.js';
  //     createChatRoute(config, { identity })
  identity: (_req) => undefined,
});
`,
    wiring: {
      // Mounted by the server file, not by gnl.config.ts — it is an HTTP surface, like the REST API
      // and Studio, and those are mounted next to it in src/server.ts.
      import: "import { chat } from './src/routes/chat.js';",
      place: 'configField',
      code: '',
    },
    humanWire: `Mount it next to the REST API in your server file:
  import { chat } from './routes/chat.js';
  // Hono:  server.mount('/api', chat)
  // Express / Fastify / Koa / Nest / node:http:  toNodeHandler(chat), same as the API
Then point the client at it:  useChat({ api: '/api/agents/assistant/chat' })`,
    note: 'The route ships with NO auth of its own, deliberately: it names the subject through the `identity` hook and nothing else. Read that hook from a verified session — never from the request body.',
  },

  processors: {
    id: 'processors',
    label: 'Guards',
    hint: 'PII, injection, tool surface',
    // A FOLDER, like tools/ and workflows/, because this one grows: the file is a LIST, and the
    // guard you write yourself (a domain blocklist, a house rule about what may leave) belongs next
    // to the ones that came with it. The single-value recipes — memory, auth, cache, otel — stay at
    // src/ root, because each of those is one thing the config points at, not a set.
    file: 'src/processors/index.ts',
    dep: '@gnldev/processors',
    variants: [
      { id: 'pii', label: 'Mask personal data', hint: 'email, phone, card — before the journal', default: true },
      { id: 'injection', label: 'Stop obvious injection attempts', hint: 'a regex list, not a defence', default: true },
      { id: 'untrusted', label: 'Label tool output as untrusted', hint: 'the indirect-injection case', default: true },
      { id: 'limits', label: 'Cap context and output size', hint: 'cost and runaway generations' },
      { id: 'tools', label: 'Restrict the tool surface', hint: 'needs YOUR allow-list — edit after' },
      { id: 'moderation', label: 'Blocklist tripwire', hint: 'needs YOUR terms — inert until then' },
    ],
    contents: (picked = ['pii', 'injection', 'untrusted']) => {
      const on = (id: string): boolean => picked.includes(id);
      const imports = [
        on('pii') && 'piiRedactor',
        on('injection') && 'promptInjectionDetector',
        on('untrusted') && 'untrustedToolContent',
        on('tools') && 'toolFilter',
        on('moderation') && 'moderationProcessor',
        on('limits') && 'tokenLimit',
        on('limits') && 'outputLimit',
      ].filter((x): x is string => !!x);
      const body: string[] = [];
      if (on('pii')) body.push(
        '  // DATA EXPOSURE — masks email addresses, phone numbers and card-shaped digits (checksum-',
        '  // validated, so a random sixteen digits is not "a card") before the model, the journal and any',
        '  // trace exporter see them. Lowers exposure; does not make a prompt safe to pass anywhere.',
        '  piiRedactor(),',
        '');
      if (on('injection')) body.push(
        '  // THE OBVIOUS ATTEMPTS — "ignore previous instructions" and friends, as a fixed regex list.',
        '  // Stops the run with a tripwire when one matches. It catches the lazy attack and NONE of the',
        '  // real ones: paraphrase, base64, another language, or instructions staged over several turns',
        '  // all walk past it. Keep it for the noise reduction, never as the reason a flow is safe.',
        '  promptInjectionDetector(),',
        '');
      if (on('untrusted')) body.push(
        '  // INDIRECT INJECTION — the dangerous kind. A tool returns a web page, a file, a ticket body,',
        '  // and that text carries instructions. This wraps tool output in <untrusted-content> and tells',
        '  // the model to ignore instructions inside it. A LABEL, not a boundary: the model may obey.',
        '  untrustedToolContent(),',
        '');
      if (on('tools')) body.push(
        '  // THE SURFACE ITSELF — the one line here that limits what an injection can DO. A model that',
        '  // cannot see a tool cannot be talked into calling it. EDIT THIS LIST: it is your allow-list,',
        '  // and as written it lets through exactly the demo tool.',
        "  toolFilter({ allow: ['chargeOrder'] }),",
        '');
      if (on('moderation')) body.push(
        '  // A TRIPWIRE, not a classifier: it matches the terms you give it, and an empty list matches',
        '  // nothing. Fill this in or remove the line — an inert guard reads as a guard.',
        '  moderationProcessor({ blocklist: [] }),',
        '');
      if (on('limits')) body.push(
        '  // RESOURCE CEILINGS — a long conversation is a cost and latency problem before it is a safety',
        '  // one; `outputLimit` also caps what a runaway generation can dump into the journal.',
        '  tokenLimit({ maxTokens: 100_000 }),',
        '  outputLimit({ maxChars: 100_000 }),',
        '');
      while (body.length && body[body.length - 1] === '') body.pop();
      return `// GUARDS — what reaches the model, and what comes back.
//
// These run on EVERY agent in this project (gnl.config.ts's top-level \`processors\`), before each
// agent's own. Input guards run BEFORE the input is journaled, so a mask is recorded masked and is
// not re-applied on resume.
//
// READ THIS BEFORE YOU TRUST IT. Prompt injection is an UNSOLVED problem: a model cannot reliably
// tell instructions from data, so nothing in this file is a security boundary. The pattern-matchers
// reduce noise and the untrusted-content wrapper is a label; what actually limits the damage is the
// tool surface plus the approval gates the engine already gives you. Layer them; do not rely on any
// single line here for a decision that moves money, deletes data or grants access.
//
// This file was generated from what you picked (\`gnl add processors\` — add or remove freely; the
// full set is in @gnldev/processors). YOUR OWN guards go next to it: write \`./house-rules.ts\`
// exporting a \`Processor\` and add it to the array — a processor is an ordinary function over the
// message list, there is nothing privileged about the ones shipped here.
import {
${imports.map((i) => `  ${i},`).join('\n')}
} from '@gnldev/processors';
import type { Processor } from '@gnldev/durable';

export const processors: Processor[] = [
${body.join('\n')}
];
`;
    },
    wiring: {
      import: "import { processors } from './src/processors/index.js';",
      place: 'configField',
      code: 'processors',
    },
    humanWire: `import { processors } from './src/processors/index.js';
// …then add to the config object (top level — it applies to every agent):
  processors,`,
    note: 'None of these is a security boundary. The detector is a regex list, the untrusted-content wrapper is a label a model may ignore, and the redactor lowers exposure rather than sanitising. What actually bounds the blast radius is the tool surface (least privilege) and the engine\'s own approval gate on side-effecting tools.',
  },

  cache: {
    id: 'cache',
    label: 'Cross-run cache',
    hint: 'skip repeated computation',
    file: 'src/cache.ts',
    dep: '@gnldev/cache',
    contents: `// A cache for the expensive things that are not model calls: embeddings, a slow lookup, a
// third-party fetch you pay per request for.
//
// WHAT IT IS NOT. Within one run, the journal already prevents a repeat — that is replay, and it is
// free. This is the CROSS-RUN case: the same input computed in a different run, tomorrow, by another
// worker. Keyed by a content hash of whatever you pass, so two callers with the same input meet.
import { createCache } from '@gnldev/cache';
import config from '../gnl.config.js';

// One namespace per kind of thing. Sharing a namespace across kinds is how a cache starts returning
// an embedding to something that asked for a price.
export const embeddings = createCache(config.storage!.cache, 'embeddings');

// Usage, wherever the expensive thing happens:
//
//   const vec = await embeddings.getOrCompute({ text }, () => embed(text));
//
// Side-effecting work does NOT belong here: a cache miss runs the function, and "miss" is a
// decision about storage, not about whether the effect already happened. For that, the tool-level
// \`idempotency\` in src/tools/ is the mechanism.
`,
    wiring: { import: '', place: 'configField', code: '' },
    humanWire: `Nothing to add to gnl.config.ts — import it where the expensive call happens:
  import { embeddings } from './cache.js';
  const vec = await embeddings.getOrCompute({ text }, () => embed(text));`,
    note: 'Cache a PURE computation. If the function has a side effect, a cache miss repeats it — use a tool with `idempotency` instead.',
  },

  otel: {
    id: 'otel',
    label: 'OpenTelemetry export',
    hint: 'journal → traces',
    file: 'src/otel.ts',
    dep: '@gnldev/otel',
    contents: `// Runs, as traces your existing tooling already understands (Jaeger, Tempo, Honeycomb, …).
//
// Exported FROM THE JOURNAL, not collected live: the trace is built from what was recorded, so it
// is the same whether you export it a second or a week after the run — and a replayed run produces
// the same spans rather than a second, differently-timed story.
import { toJournal } from '@gnldev/durable';
import { exportRun } from '@gnldev/otel';
import { piiTextRedactor } from '@gnldev/processors';
import config from '../gnl.config.js';

// The redactor matters here more than anywhere else: a span carries prompts and tool arguments, and
// a trace backend is usually the least access-controlled copy of your data. Drop it only if you have
// decided that on purpose.
export async function exportTrace(runId: string): Promise<void> {
  // \`toJournal\` and not \`storage.runs\` directly: exporting READS the run back, and the run store's
  // write interface does not promise that. Same bridge src/app.ts hands to Studio.
  await exportRun(toJournal(config.storage!.runs), runId, {
    endpoint: process.env.OTEL_ENDPOINT ?? 'http://localhost:4318/v1/traces',
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'gnl-app',
    redact: piiTextRedactor(),
  });
}

// Call it where a run ends — after \`gnl.run(...)\` returns, in a job handler, or from a small
// sweeper that walks recent runs. There is no background exporter here on purpose: a framework that
// ships data out by default is a framework that ships data out by surprise.
`,
    wiring: { import: '', place: 'configField', code: '' },
    humanWire: `Nothing to add to gnl.config.ts — call it when a run finishes:
  import { exportTrace } from './otel.js';
  await exportTrace(runId);
Set OTEL_ENDPOINT / OTEL_SERVICE_NAME in .env (defaults to a local collector).`,
    env: ['OTEL_ENDPOINT=              # optional — defaults to http://localhost:4318/v1/traces', 'OTEL_SERVICE_NAME=          # optional — defaults to gnl-app'],
    note: 'Spans are built from the journal, so a swept run cannot be exported afterwards — export before `gnl sweep` reaches it, or keep the retention window longer than your trace pipeline needs.',
  },

  // ── Real-provider model recipes (`gnl add model <provider>`) ─────────────────────────────────
  // The one friction every user hits: the scaffold ships a mock model, and the step from mock to a
  // real provider used to be "hand-write src/model.ts against the AI SDK docs" — measured in a
  // registry rehearsal, even knowing the APIs it took reading the template plus the provider docs.
  // Each recipe writes a NEW file next to the mock (never over it): the mock stays for offline work,
  // and the switch is one import line the instruction prints. Deliberately NOT in FEATURE_IDS: the
  // init checkbox composes tools around one assistant, and two files exporting `assistant` is a
  // choice a person makes, not a checkbox.
  'model-nvidia': modelRecipe('nvidia', 'NVIDIA NIM', '@ai-sdk/openai-compatible', `// Real provider: NVIDIA NIM, through the OpenAI-compatible surface.
// Env (put them in .env — never commit it): NVIDIA_API_KEY (required), NVIDIA_MODEL (optional).
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const nim = createOpenAICompatible({
  name: 'nvidia',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: process.env.NVIDIA_API_KEY ?? '',
});

export const model = nim(process.env.NVIDIA_MODEL ?? 'poolside/laguna-xs-2.1');
`, ['NVIDIA_API_KEY=            # required — https://build.nvidia.com', 'NVIDIA_MODEL=              # optional — defaults to poolside/laguna-xs-2.1']),
  'model-openai': modelRecipe('openai', 'OpenAI', '@ai-sdk/openai', `// Real provider: OpenAI.
// Env (put it in .env — never commit it): OPENAI_API_KEY (required), OPENAI_MODEL (optional).
import { openai } from '@ai-sdk/openai';

export const model = openai(process.env.OPENAI_MODEL ?? 'gpt-5');
`, ['OPENAI_API_KEY=            # required', 'OPENAI_MODEL=              # optional — defaults to gpt-5']),
  'model-anthropic': modelRecipe('anthropic', 'Anthropic', '@ai-sdk/anthropic', `// Real provider: Anthropic.
// Env (put it in .env — never commit it): ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional).
import { anthropic } from '@ai-sdk/anthropic';

export const model = anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5');
`, ['ANTHROPIC_API_KEY=         # required', 'ANTHROPIC_MODEL=           # optional — defaults to claude-sonnet-5']),
  'model-openai-compatible': modelRecipe('openai-compatible', 'any OpenAI-compatible endpoint', '@ai-sdk/openai-compatible', `// Real provider: any OpenAI-compatible endpoint (vLLM, Ollama serve, a gateway, …).
// Env (put them in .env — never commit it): OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL,
// OPENAI_COMPAT_API_KEY (leave unset for a local server that wants none).
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const provider = createOpenAICompatible({
  name: 'compat',
  baseURL: process.env.OPENAI_COMPAT_BASE_URL ?? 'http://localhost:11434/v1',
  ...(process.env.OPENAI_COMPAT_API_KEY ? { apiKey: process.env.OPENAI_COMPAT_API_KEY } : {}),
});

export const model = provider(process.env.OPENAI_COMPAT_MODEL ?? '');
`, ['OPENAI_COMPAT_BASE_URL=    # required — e.g. http://localhost:11434/v1', 'OPENAI_COMPAT_MODEL=       # required — the model id that endpoint serves', 'OPENAI_COMPAT_API_KEY=     # optional — leave unset for a local server']),
};

/** The shared shape of the four model recipes — one place for the wiring story they all tell. */
function modelRecipe(provider: string, label: string, dep: string, contents: string, env: string[]): Recipe {
  const file = `src/models/${provider}.ts`;
  return {
    id: `model-${provider}`,
    label: `Real model: ${label}`,
    file,
    contents,
    dep,
    env,
    wiring: {
      import: `import { model } from './${file.replace(/\.ts$/, '.js')}';`,
      place: 'configField',
      code: 'agents: { assistant }',
    },
    humanWire: `In src/agents/assistant.ts, two lines:
  import { model } from '../models/${provider}.js';
  …and in the config object:  model,   (replacing the echoModel() line — the mock import can go)`,
    note: `put the key in .env in the project root — gnl dev/studio load it on start, and the shell still wins. Add .env to .gitignore.`,
  };
}

/** The non-code feature: adds an end-to-end test + vitest (handled specially by scaffold). */
export const E2E_FEATURE = 'e2e' as const;

/** Every selectable feature id, in checkbox order (idempotency-tool first — it's the edge). */
export const FEATURE_IDS: readonly string[] = [
  'idempotency-tool',
  'chat',
  'schedule',
  'job',
  'processors',
  'cache',
  'otel',
  'rag',
  'mcp',
  'memory',
  'workflow',
  'auth',
  E2E_FEATURE,
];

export interface CheckboxItem {
  id: string;
  label: string;
  hint?: string;
}

/** Checkbox rows for `gnl init` (recipes + the special e2e row). */
export const CHECKBOX_ITEMS: CheckboxItem[] = FEATURE_IDS.map((id) => {
  if (id === E2E_FEATURE) return { id, label: 'End-to-end durability test', hint: 'vitest' };
  const r = RECIPES[id]!;
  return { id: r.id, label: r.label, hint: r.hint };
});

/** True if `id` is a valid feature (a recipe or e2e). */
export function isFeature(id: string): boolean {
  return FEATURE_IDS.includes(id);
}

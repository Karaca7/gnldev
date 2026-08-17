import { randomBytes } from 'node:crypto';
// Shared feature recipes — the single source used by BOTH `gnl add <feature>` (writes the src file +
// Prints hand-wiring) and `gnl init` feature-composition (writes the src file + GENERATES gnl.config.ts).
//
// Each recipe is a real, type-correct src file against the current package APIs (@gnldev/rag,
// @gnldev/memory, @gnldev/mcp, @gnldev/workflow, @gnldev/auth, @gnldev/durable) plus a structured `wiring` describing
// How it slots into the decoupled gnl.config.ts (agentTool → an agent's `tools`; configField → a
// Top-level config property). `humanWire` is the corrected instruction `gnl add` prints (the config is
// Decoupled now — NO `defineConfig({ … })`; you edit the plain config object).

/** Where a recipe's export slots into the generated gnl.config.ts. */
export type WiringPlace = 'agentTool' | 'configField';

/** Resolves a recipe's contents, whether static or generated. */
export function recipeContents(r: Recipe): string {
  return typeof r.contents === 'function' ? r.contents() : r.contents;
}

/**
 * A per-project development token. Random, so it is never a value anyone can look up in this
 * package's published source — which is what `admin-dev` was.
 */
function devToken(role: string): string {
  return `${role}-${randomBytes(9).toString('base64url')}`;
}

export interface RecipeWiring {
  /** The import line to add to gnl.config.ts, e.g. "import { searchDocs } from './src/rag.js';". */
  import: string;
  place: WiringPlace;
  /** agentTool → an entry inside an agent's `tools: { … }` (e.g. `searchDocs`, or a spread `...mcpToolset`).
   *  ConfigField → a top-level config property (e.g. `memoryFactory`, `workflows: { checkout }`). */
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
  contents: string | (() => string);
  /** npm dependency to add to package.json (omit if already in the base template — e.g. memory/auth). */
  dep?: string;
  /** How this recipe wires into gnl.config.ts (omit → nothing to wire, file is self-contained). */
  wiring: RecipeWiring;
  /** The corrected instruction `gnl add` prints (decoupled: edit the config object, NOT defineConfig). */
  humanWire: string;
  /** Honesty note about maturity / required setup, if any. */
  note?: string;
  /** When the wired field lives on the dev-server config (GnlDevConfig) rather than CreateGnlConfig,
   *  The generated `satisfies` clause must be widened with this type literal (e.g. auth). */
  configTypeExt?: string;
}

export const RECIPES: Record<string, Recipe> = {
  'idempotency-tool': {
    id: 'idempotency-tool',
    label: 'Idempotent charge tool',
    hint: "GNL's edge",
    file: 'src/tools.ts',
    // Kept in sync with templates/full/src/tools.ts (the static `--template full` starter).
    contents: `// A side-effecting durable tool that showcases GNL's edge: LLM-aware idempotency.
//
// \`idempotency: 'args'\` keys the journal by the tool's ARGUMENTS instead of the AI SDK's
// Per-call \`toolCallId\`. So even when the model re-plans the same call under a brand-new
// \`toolCallId\` — the dominant real-world double-charge case (a documented AI SDK pattern) — the tool
// Runs exactly once and every duplicate gets the journaled result. \`idempotencyKey\` narrows
// The dedup to a logical key (here: \`orderId\`), so two calls with the same orderId but
// Otherwise different args still collapse to one execution.

// A stand-in "ledger" so the demo/e2e can observe how many times the side effect really ran.
// In a real app this would be a DB write / a Stripe charge / an email send.
export const ledger: { charges: { orderId: string; amount: number }[] } = { charges: [] };

export const chargeOrder = {
  description: 'Charge a customer order (has a real side effect — must run exactly once).',
  idempotency: 'args' as const,
  idempotencyKey: (args: any) => String(args.orderId),
  // Uncomment to dedup across runs too (retried jobs / re-triggered agents):
  // IdempotencyWindow: 'cross-run' as const,
  execute: async ({ orderId, amount }: { orderId: string; amount: number }) => {
    ledger.charges.push({ orderId, amount });
    return { charged: amount, orderId, receipt: \`rcpt_\${orderId}\` };
  },
};
`,
    wiring: {
      import: "import { chargeOrder } from './src/tools.js';",
      place: 'agentTool',
      code: 'chargeOrder',
    },
    humanWire: `import { chargeOrder } from './src/tools.js';
// …then add it to an agent's tools inside the config object:
  agents: { assistant: { ...assistant, tools: { chargeOrder } } }`,
    note: "GNL's edge: this tool runs exactly once even when the model re-emits the same call under a new toolCallId (a documented AI SDK pattern).",
  },

  rag: {
    id: 'rag',
    label: 'RAG (retrieval tool)',
    file: 'src/rag.ts',
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
      import: "import { searchDocs } from './src/rag.js';",
      place: 'agentTool',
      code: 'searchDocs',
    },
    humanWire: `import { searchDocs } from './src/rag.js';
// …then add it to an agent's tools inside the config object:
  agents: { assistant: { ...assistant, tools: { searchDocs } } }`,
  },

  mcp: {
    id: 'mcp',
    label: 'MCP tools',
    file: 'src/mcp.ts',
    dep: '@gnldev/mcp',
    contents: `// Connect an MCP server and expose its tools to your agent.
// \`mcpTools(...)\` opens no connection until \`.tools()\` is called; we resolve the toolset here (top-level
// Await) so it can be spread into an agent's \`tools\`. Until you point it at a real server this is empty,
// So the app still boots — replace the export below with the two commented lines once you have one.
import { mcpTools } from '@gnldev/mcp';
import type { ToolSet } from 'ai';

// Const handle = mcpTools({ transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } });
// Export const mcpToolset: ToolSet = await handle.tools();
export const mcpToolset: ToolSet = {};
`,
    wiring: {
      import: "import { mcpToolset } from './src/mcp.js';",
      place: 'agentTool',
      code: '...mcpToolset',
    },
    humanWire: `import { mcpToolset } from './src/mcp.js';
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
    file: 'src/workflow.ts',
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
      import: "import { checkout } from './src/workflow.js';",
      place: 'configField',
      code: 'workflows: { checkout }',
    },
    humanWire: `import { checkout } from './src/workflow.js';
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
};

/** The non-code feature: adds an end-to-end test + vitest (handled specially by scaffold). */
export const E2E_FEATURE = 'e2e' as const;

/** Every selectable feature id, in checkbox order (idempotency-tool first — it's the edge). */
export const FEATURE_IDS: readonly string[] = [
  'idempotency-tool',
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

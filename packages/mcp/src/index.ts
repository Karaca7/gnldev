// @gnldev/mcp — MCP client (adapts external tools to the AI SDK) + server (exposes our own tools as MCP).
// Both are durable: client calls are exactly-once within runDurable; server callTool is exactly-once via idempotencyKey.
import { tool, jsonSchema } from 'ai';
import { argsHash } from '@gnldev/durable';

export { createMcpServer, serveMcp } from './server.js';
export type { McpServer, McpServerOptions, McpServerToolDef } from './server.js';
export { mcpFirewall, composeGuards, mcpPinKey } from './firewall.js';
export type { McpFirewallOptions, McpPinRecord } from './firewall.js';

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: any; // JSON Schema
}

/** The minimal surface of an MCP Client that we need (@modelcontextprotocol/sdk Client provides this). */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolDef[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }): Promise<any>;
  /** Present on the SDK Client (inherited from Protocol); closes the connection. Optional on fake clients. */
  close?(): Promise<void>;
}

export interface McpToolsOptions {
  /** Prefix for tool names (to avoid collisions, e.g. 'github_'). */
  prefix?: string;
  /**
   * A fixed idempotencyKey (optional, external). In the normal flow, EVERY execute call receives
   * `options.idempotencyKey` from `runDurable`'s `durableTool` wrapper (`${runId}:${toolCallId}`, see
   * packages/durable/src/durable-tool.ts line 227/232) — execute reads THIS here and carries it into the
   * MCP request as `params._meta.idempotencyKey` (MCP spec: `_meta` is a free/'loose' meta field) →
   * SERVER-SIDE exactly-once is also active via the real SDK Client/Server. OUTSIDE `runDurable`
   * (when there is no durable context), the fixed value given here is used. If neither is present,
   * `_meta` is NOT sent AT ALL → the old behavior (every call runs) is preserved — backward compatible.
   */
  idempotencyKey?: string;
}

/** Converts a list of McpToolDef into an AI SDK ToolSet (execute → client.callTool). The prefix avoids collisions. */
function toolsFromDefs(client: McpClientLike, defs: McpToolDef[], opts: McpToolsOptions = {}): Record<string, any> {
  const out: Record<string, any> = {};
  const prefix = opts.prefix ?? '';
  for (const t of defs) {
    const name = prefix + t.name;
    out[name] = tool({
      description: t.description ?? t.name,
      inputSchema: jsonSchema(t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true }),
      execute: async (args: any, toolOpts?: any) => {
        // If there is a durable context, toolOpts.idempotencyKey already arrives derived from runId:toolCallId;
        // otherwise (e.g. usage outside runDurable) fall back to opts.idempotencyKey (if given externally).
        const idempotencyKey = toolOpts?.idempotencyKey ?? opts.idempotencyKey;
        const res = await client.callTool({
          name: t.name,
          arguments: args,
          ...(idempotencyKey ? { _meta: { idempotencyKey } } : {}),
        });
        // MCP result is usually { content: [...] }; otherwise return the raw result.
        return res?.content ?? res;
      },
    });
  }
  return out;
}

/**
 * Lists the MCP server's tools and converts each to an AI SDK `tool()`. execute calls MCP
 * `callTool`. When the result is passed to `runDurable`, `durableTool` wraps it → the MCP call is
 * journaled (not re-called on resume). An optional prefix avoids name collisions.
 */
export async function createMcpTools(client: McpClientLike, opts: McpToolsOptions = {}): Promise<Record<string, any>> {
  const { tools } = await client.listTools();
  return toolsFromDefs(client, tools, opts);
}

/**
 * Lazily loads `@modelcontextprotocol/sdk` and returns a Client connected to a transport (optional peer).
 * The dynamic import is done via a string variable → build/bundle doesn't break if the SDK isn't installed.
 */
export async function connectMcp(transport: any, info: { name?: string; version?: string } = {}): Promise<McpClientLike> {
  const mod = '@modelcontextprotocol/sdk/client/index.js';
  const { Client } = (await import(mod)) as any;
  const client = new Client({ name: info.name ?? 'gnl', version: info.version ?? '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client as McpClientLike;
}

// --- W1: mcpTools(options) — connect to a real SDK transport + discover + convert to AI SDK tool ----

/** stdio: spawn a subprocess and talk over stdin/stdout. http: streamable-HTTP MCP server. */
export type McpTransportSpec =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string | URL; headers?: Record<string, string> }
  | { kind: 'custom'; transport: any }; // a pre-built Transport (e.g. InMemoryTransport in tests)

export interface McpToolsConnectOptions {
  transport: McpTransportSpec;
  /** Prefix for tool names (to avoid collisions, e.g. 'github_'). */
  prefix?: string;
  /** Client identity to announce in the MCP initialize handshake. */
  info?: { name?: string; version?: string };
  /** see McpToolsOptions.idempotencyKey — optional fixed fallback for usage outside runDurable. */
  idempotencyKey?: string;
}

/** A firewall-ready summary of an MCP tool definition (to be consumed by W2). descriptionHash: stableStringify+sha256 (argsHash). */
export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema: any;
  descriptionHash: string;
}

function summarizeToolDef(t: McpToolDef): McpToolSummary {
  const inputSchema = t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true };
  const description = t.description;
  return { name: t.name, description, inputSchema, descriptionHash: argsHash({ name: t.name, description: description ?? null, inputSchema }) };
}

/** Discovers and summarizes the tools of an already-connected client (name+description+schema+hash). NO extra journal logic. */
export async function describeTools(client: McpClientLike): Promise<McpToolSummary[]> {
  const { tools } = await client.listTools();
  return tools.map(summarizeToolDef);
}

async function buildTransport(spec: McpTransportSpec): Promise<any> {
  if (spec.kind === 'custom') return spec.transport;
  if (spec.kind === 'stdio') {
    const mod = '@modelcontextprotocol/sdk/client/stdio.js';
    const { StdioClientTransport } = (await import(mod)) as any;
    return new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd });
  }
  if (spec.kind === 'http') {
    const mod = '@modelcontextprotocol/sdk/client/streamableHttp.js';
    const { StreamableHTTPClientTransport } = (await import(mod)) as any;
    const url = spec.url instanceof URL ? spec.url : new URL(spec.url);
    return new StreamableHTTPClientTransport(url, spec.headers ? { requestInit: { headers: spec.headers } } : undefined);
  }
  throw new Error(`mcpTools: unknown transport.kind '${(spec as any).kind}'`);
}

/** The handle returned by `mcpTools(...)`: the connection is established LAZILY (on first use), closed via `close()`. */
export interface McpToolsHandle {
  /** AI SDK tool set (connect+discover on first call; subsequent calls share the same discovery). */
  tools(): Promise<Record<string, any>>;
  /** Firewall readiness (W2): a {name, description, inputSchema} summary + descriptionHash for each discovered tool. */
  describeTools(): Promise<McpToolSummary[]>;
  /** Closes the connection; no-op if never connected (idempotent). */
  close(): Promise<void>;
}

/**
 * Connects to an MCP server (stdio or streamable-http), discovers its tools via `tools/list`, and
 * converts each to an AI SDK tool (execute → `tools/call`). The connection is established LAZILY:
 * the `mcpTools(...)` call itself does no I/O — the transport opens on the first `tools()`/`describeTools()`
 * call, and the discovery result is shared for the lifetime of this handle. `close()` closes the transport.
 *
 * DURABILITY: MCP tool calls are already journaled inside `runDurable` (see README) — there is NO
 * SEPARATE journal/exactly-once logic here, nothing is reproduced. The `idempotencyKey`
 * (`${runId}:${toolCallId}`) coming from `runDurable`'s `durableTool` wrapper is carried to execute via
 * `params._meta` → in addition to CLIENT-SIDE (in-process, journal) exactly-once, if the other side is
 * also using `createMcpServer({ journal })`, SERVER-SIDE exactly-once also runs over the wire.
 */
export function mcpTools(opts: McpToolsConnectOptions): McpToolsHandle {
  let clientPromise: Promise<McpClientLike> | undefined;
  let listPromise: Promise<{ tools: McpToolDef[] }> | undefined;

  function ensureClient(): Promise<McpClientLike> {
    if (!clientPromise) clientPromise = buildTransport(opts.transport).then((t) => connectMcp(t, opts.info));
    return clientPromise;
  }

  function ensureList(): Promise<{ tools: McpToolDef[] }> {
    if (!listPromise) listPromise = ensureClient().then((c) => c.listTools());
    return listPromise;
  }

  return {
    async tools() {
      const client = await ensureClient();
      const { tools } = await ensureList();
      return toolsFromDefs(client, tools, opts);
    },
    async describeTools() {
      const { tools } = await ensureList();
      return tools.map(summarizeToolDef);
    },
    async close() {
      if (!clientPromise) return; // never connected → no-op
      const client = await clientPromise;
      clientPromise = undefined;
      listPromise = undefined;
      await client.close?.();
    },
  };
}

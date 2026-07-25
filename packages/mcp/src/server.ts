// MCP server side: EXPOSE durable agents' tools over the MCP protocol (for others to consume).
// If a journal is given, every callTool is wrapped with durableTool → SERVER-SIDE exactly-once (a repeated
// request with the same idempotencyKey produces the side effect only once — absent from most MCP server implementations).
import { durableTool } from '@gnldev/durable';
import type { Journal } from '@gnldev/durable';
import type { McpToolDef } from './index.js';

export interface McpServerToolDef {
  description?: string;
  inputSchema?: any; // JSON Schema
  execute: (args: any, opts?: any) => Promise<any> | any;
}

export interface McpServerOptions {
  /** Tools to expose (AI SDK tool or {description,inputSchema,execute}). */
  tools: Record<string, McpServerToolDef>;
  /** If given, callTool is wrapped with durableTool → server-side exactly-once (via idempotencyKey). */
  journal?: Journal;
}

export interface McpServer {
  listTools(): { tools: McpToolDef[] };
  callTool(req: { name: string; arguments?: Record<string, unknown>; idempotencyKey?: string }): Promise<any>;
}

// ---- Argument validation (callTool, BEFORE execute) ------------------------------------------
// inputSchema can arrive in two forms: a plain JSON Schema object (for the listTools announcement) or
// an EXECUTABLE schema — a zod/valibot-like `safeParse` or the standard-schema `~standard`
// interface (AI SDK tools can carry either). If there is NO executable surface, validation is
// SKIPPED: we have no JSON Schema interpreter, and a false-positive rejection (dropping a valid
// request) is worse than not validating at all — in this case the old behavior is preserved as-is.
type ArgCheck = { ok: true; value: any } | { ok: false; message: string };

/** Makes the issue path human-readable (standard-schema path items can be a `{ key }` object). */
function formatIssuePath(path: any): string {
  if (!Array.isArray(path) || path.length === 0) return '(root)';
  return path.map((seg: any) => (seg && typeof seg === 'object' && 'key' in seg ? String(seg.key) : String(seg))).join('.');
}

function formatIssues(issues: any[]): string {
  return issues.map((i: any) => `${formatIssuePath(i?.path)}: ${i?.message ?? 'invalid value'}`).join('; ');
}

/** Detects the schema type and validates args; on success returns the TRANSFORMED value (default/coercion). */
async function checkToolArgs(schema: any, args: Record<string, unknown>): Promise<ArgCheck> {
  if (!schema || typeof schema !== 'object') return { ok: true, value: args };
  // 1) zod/valibot-like: safeParse — synchronous; r.data is the transformed value.
  if (typeof schema.safeParse === 'function') {
    const r = schema.safeParse(args);
    if (r?.success) return { ok: true, value: r.data };
    const issues = r?.error?.issues ?? r?.error?.errors ?? [];
    return { ok: false, message: formatIssues(issues) || String(r?.error ?? 'schema validation failed') };
  }
  // 2) standard-schema (`~standard.validate`) — per spec the result can be sync or a Promise.
  const std = schema['~standard'];
  if (std && typeof std.validate === 'function') {
    const r = await std.validate(args);
    if (r?.issues) return { ok: false, message: formatIssues(r.issues as any[]) || 'schema validation failed' };
    return { ok: true, value: r?.value };
  }
  // 3) Plain JSON Schema / unrecognized type → validation is skipped (rationale above; old behavior).
  return { ok: true, value: args };
}

/** Produces an MCP server surface from a tool set (listTools + callTool). */
export function createMcpServer(opts: McpServerOptions): McpServer {
  return {
    listTools() {
      return {
        tools: Object.entries(opts.tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
        })),
      };
    },
    async callTool(req) {
      const t = opts.tools[req.name];
      if (!t || typeof t.execute !== 'function') throw new Error(`MCP server: no such tool: ${req.name}`);
      // Validate arguments against inputSchema BEFORE execute (if the schema is executable).
      // Invalid arg → MCP's structured tool error ({ isError, content }) — the serveMcp bridge
      // doesn't touch results that already carry content, so this error passes through the protocol as-is.
      const checked = await checkToolArgs(t.inputSchema, req.arguments ?? {});
      if (!checked.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid argument (tool: ${req.name}) — ${checked.message}` }],
        };
      }
      // journal + idempotencyKey → durableTool: same key again → cache (server-side exactly-once).
      if (opts.journal && req.idempotencyKey) {
        const dt = durableTool(t, { journal: opts.journal, runId: req.idempotencyKey }, req.name);
        return dt.execute!(checked.value, { toolCallId: 'mcp' });
      }
      return t.execute(checked.value);
    },
  };
}

/**
 * Lazily loads the `@modelcontextprotocol/sdk` Server and connects it to a transport; publishes
 * createMcpServer as a real MCP server (optional peer; string-import → build doesn't break without the SDK).
 */
export async function serveMcp(server: McpServer, transport: any, info: { name?: string; version?: string } = {}): Promise<void> {
  const [{ Server }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js') as Promise<any>,
    import('@modelcontextprotocol/sdk/types.js') as Promise<any>,
  ]);
  const s = new Server({ name: info.name ?? 'gnl', version: info.version ?? '0.0.0' }, { capabilities: { tools: {} } });
  // setRequestHandler expects a REAL Zod schema (it reads the method literal from the schema) — a plain
  // `{ method: '...' }` object blows up in the SDK with "Schema is missing a method literal".
  s.setRequestHandler(ListToolsRequestSchema, async () => server.listTools());
  s.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    // Defensive check: the SDK schema normally guarantees this, but the bridge must NEVER pass a
    // non-string name to createMcpServer — otherwise the error message would be misleading.
    const name = req?.params?.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`MCP bridge: 'params.name' for tools/call must be a non-empty string (received: ${name === '' ? 'empty string' : typeof name})`);
    }
    // MCP spec: params._meta is a free/'loose' meta field — the client (see src/index.ts
    // toolsFromDefs) carries idempotencyKey here. If present, pass it to createMcpServer.callTool →
    // journal-based server-side exactly-once is now also active for real MCP Client calls.
    const idempotencyKey = req.params?._meta?.idempotencyKey;
    const result = await server.callTool({
      name,
      arguments: req.params?.arguments,
      ...(typeof idempotencyKey === 'string' && idempotencyKey ? { idempotencyKey } : {}),
    });
    // The SDK validates the handler's return against CallToolResultSchema (expects `{ content: [...] }`).
    // createMcpServer's tools can return a raw value (existing contract preserved) — here, ONLY in the
    // bridge, wrap it into MCP content format (if it's already in that format, DON'T TOUCH it).
    if (result && typeof result === 'object' && Array.isArray((result as any).content)) return result;
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  });
  await s.connect(transport);
}

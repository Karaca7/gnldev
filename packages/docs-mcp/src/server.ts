// MCP stdio server orchestration: serves the initialize / tools/list / tools/call methods over
// JSON-RPC 2.0 (protocol layer: protocol.ts). Tool logic first tries to fetch live
// /llms.txt + /llms-full.txt via GNL_DOCS_URL (docs-source.ts); if unreachable, falls back to
// the embedded static content in content.ts (text.ts). Transport (readline/stdin/stdout) is NOT
// here — see cli.ts.
import {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  isNotification,
  makeError,
  makeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from './protocol.js';
import { extractRemoteSection, fetchRemoteDocs, isOffline, resolveDocsUrl, type RemoteDocs } from './docs-source.js';
import {
  buildFeatureText,
  buildOverviewText,
  buildSearchResultsText,
  buildUnknownSlugText,
  searchLocal,
  searchRemoteFullText,
  FEATURES_BY_SLUG,
} from './text.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'gnl-docs-mcp';
export const SERVER_VERSION = '0.1.0';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** tools/list response — 3 tools: overview/feature/search (see task spec). */
export const TOOLS: ToolDef[] = [
  {
    name: 'gnl_docs_overview',
    description: 'Returns a summary of the GNL framework and the ordered list of its 25 features.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gnl_docs_feature',
    description: `Returns the installation/API/example detail for the GNL feature with the given slug.`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: `Feature slug (e.g. 'exactly-once-tools'); call gnl_docs_overview first for the full list.` },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'gnl_docs_search',
    description: 'Performs a simple (case-insensitive) text search across the GNL docs.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Doc content provider: tries the live fetch AT MOST once per process lifetime and caches the
 * result (success or failure) in memory — it does not re-fetch on every tool call.
 */
export function createDocsProvider(env: NodeJS.ProcessEnv = process.env) {
  const docsUrl = resolveDocsUrl(env);
  const offline = isOffline(env);
  let remoteCache: RemoteDocs | null | undefined; // undefined = not attempted yet

  async function getRemote(): Promise<RemoteDocs | null> {
    if (offline) return null;
    if (remoteCache !== undefined) return remoteCache;
    remoteCache = await fetchRemoteDocs(docsUrl);
    return remoteCache;
  }

  return {
    docsUrl,
    async overview(): Promise<string> {
      const remote = await getRemote();
      return remote ? remote.llmsTxt : buildOverviewText(docsUrl);
    },
    async feature(slug: string): Promise<string> {
      const remote = await getRemote();
      if (remote) {
        const section = extractRemoteSection(remote.llmsFullTxt, slug);
        if (section) return section;
        // section not found remotely (slug may be wrong) — fall back to embedded content; if that's also missing, an error text is produced.
      }
      const f = FEATURES_BY_SLUG[slug];
      return f ? buildFeatureText(f, docsUrl) : buildUnknownSlugText(slug);
    },
    async search(query: string): Promise<string> {
      const remote = await getRemote();
      return remote ? searchRemoteFullText(query, remote.llmsFullTxt) : buildSearchResultsText(query, searchLocal(query));
    },
  };
}

export type DocsProvider = ReturnType<typeof createDocsProvider>;

function textResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Executes a single tools/call request; unknown tool/missing argument → isError:true result (NOT a JSON-RPC error — an MCP tool-level error). */
export async function callTool(provider: DocsProvider, name: string, args: any): Promise<ToolCallResult> {
  switch (name) {
    case 'gnl_docs_overview':
      return textResult(await provider.overview());
    case 'gnl_docs_feature': {
      const slug = args?.slug;
      if (typeof slug !== 'string' || !slug.trim()) {
        return errorResult(`Invalid argument: 'slug' is required (string).`);
      }
      return textResult(await provider.feature(slug));
    }
    case 'gnl_docs_search': {
      const query = args?.query;
      if (typeof query !== 'string' || !query.trim()) {
        return errorResult(`Invalid argument: 'query' is required (string).`);
      }
      return textResult(await provider.search(query));
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

/**
 * Handles a single JSON-RPC message and returns the response; if the message is a notification
 * (no id), returns `null` — per JSON-RPC 2.0, notifications must NEVER get a response (stays
 * silent even on error).
 */
export async function handleMessage(provider: DocsProvider, msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = msg.id ?? null;
  const notification = isNotification(msg);
  const reply = (res: JsonRpcResponse): JsonRpcResponse | null => (notification ? null : res);

  switch (msg.method) {
    case 'initialize':
      return reply(
        makeResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
    case 'notifications/initialized':
    case 'initialized':
      return null; // second step of the MCP handshake — a notification, expects no response
    case 'ping':
      return reply(makeResult(id, {}));
    case 'tools/list':
      return reply(makeResult(id, { tools: TOOLS }));
    case 'tools/call': {
      const toolName = msg.params?.name;
      if (typeof toolName !== 'string') {
        return reply(makeError(id, ERR_INVALID_PARAMS, `params.name is required (string)`));
      }
      try {
        const result = await callTool(provider, toolName, msg.params?.arguments ?? {});
        return reply(makeResult(id, result));
      } catch (err: any) {
        return reply(makeError(id, ERR_INTERNAL, err?.message ?? 'internal error'));
      }
    }
    default:
      return reply(makeError(id, ERR_METHOD_NOT_FOUND, `Unknown method: ${String(msg.method)}`));
  }
}

// Public API surface — for anyone who wants to use @gnldev/docs-mcp as a library (embedding,
// Testing). The CLI entry point (bin: gnl-docs-mcp) lives in a separate file: src/cli.ts (NOT
// Imported here — the process.stdin/exit side effect must not affect any consumer that imports
// Index.ts).
export {
  callTool,
  createDocsProvider,
  handleMessage,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  type DocsProvider,
  type ToolCallResult,
  type ToolDef,
} from './server.js';

export {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  isNotification,
  JSON_RPC_VERSION,
  makeError,
  makeResult,
  parseLine,
  serializeResponse,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type JsonRpcSuccess,
} from './protocol.js';

export { DEFAULT_DOCS_URL, isOffline, resolveDocsUrl, type RemoteDocs } from './docs-source.js';

export {
  FEATURES,
  FEATURES_BY_SLUG,
  OVERVIEW_DETAIL,
  OVERVIEW_SUMMARY,
  TIER_LABEL,
  type DocFeature,
  type DocTier,
} from './content.js';

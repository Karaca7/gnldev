// Minimal JSON-RPC 2.0 layer — the MCP stdio transport is built on top of this (hand-written,
// @modelcontextprotocol/sdk NOT USED: see the package README, wanted to avoid a lockfile race
// With W1).
//
// Transport: newline-delimited JSON — each line is a SINGLE JSON-RPC message (request/
// Notification/response), no line break within a message. Messages with an `id` field are
// Requests (a response is expected); no `id` means a notification (per JSON-RPC 2.0, NEVER
// Responded to — stays silent even on error).

export const JSON_RPC_VERSION = '2.0' as const;

/** Standard JSON-RPC 2.0 error codes (see spec §5.1). */
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: any;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: any };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** No `id` field means a notification — per JSON-RPC 2.0, no response should be produced. */
export function isNotification(msg: JsonRpcMessage): boolean {
  return msg.id === undefined;
}

export function makeResult(id: JsonRpcId, result: any): JsonRpcSuccess {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function makeError(id: JsonRpcId, code: number, message: string, data?: any): JsonRpcFailure {
  return { jsonrpc: JSON_RPC_VERSION, id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Converts a line into a JSON-RPC message; returns null on invalid JSON (caller produces -32700). */
export function parseLine(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    return null;
  }
}

export function serializeResponse(res: JsonRpcResponse): string {
  return JSON.stringify(res);
}

// Maps an MCP caller's bearer token to the identity @gnldev/mcp's `identity` hook expects.
//
// Structural types only: @gnldev/auth must not depend on @gnldev/mcp. The provider is asked exactly
// the question it answers for HTTP (`authenticate`), on a synthetic request carrying only the token.
import type { AuthProvider } from './types.js';
import { callerKind } from './scope.js';

/** What `serveMcp` forwards from the transport (`extra.authInfo`). */
export interface McpCallerLike {
  authInfo?: { token?: string };
}
/** What `createMcpServer({ identity })` consumes. */
export interface McpIdentityLike {
  resourceId?: string;
  orgId?: string;
  actor?: string;
}

/**
 * `identity` for createMcpServer, from an AuthProvider.
 *
 * Only a `subject` (an end user holding its own token) is an MCP identity: it is bound to itself and
 * its organization. An `application` would have to name its user on each call, and the only place an
 * MCP call can name anything is the request body, so it is refused; mint the user a subject token
 * (`signSubjectToken`) and hand THAT to the MCP client instead. An `operator` names nobody, so a
 * resource-scoped work id cannot be derived for it; it is refused too.
 */
export function identityFromAuth(provider: AuthProvider) {
  return async (caller: McpCallerLike): Promise<McpIdentityLike | undefined> => {
    const token = caller.authInfo?.token;
    if (!token) return undefined;
    const req = new Request('http://mcp.invalid/', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const p = await provider.authenticate(req);
    if (callerKind(p) !== 'subject') return undefined;
    return { resourceId: p!.id as string, ...(p!.orgId ? { orgId: p!.orgId } : {}), actor: p!.id as string };
  };
}

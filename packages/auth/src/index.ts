// @gnldev/auth — open-core auth seam:
// AuthProvider  → stable contract (server + studio gate against this)
//   RoleAuth      → free default (bearer/basic; superAdmin/admin/client/viewer)
//   makeGate      → shared Hono gate (allow/deny)
//   normalizeAuth → AuthProvider | {read,write} backward-compat bridge
export { PRINCIPAL_KINDS } from './types.js';
export type { Principal, PrincipalKind, AuthContext, Decision, AuthCapabilities, AuthProvider, Cred, AccessDecision, RefusalReason } from './types.js';
// The outcome a host reports to `AuthProvider.onDecision`: what the caller got, not what `authorize` said first.
export { markRefusal, outcomeOf, settleDecision, decisionNotRecorded } from './decision.js';
export { roleAuth, CLIENT_ROLE, CLIENT_WRITES, END_USER_ROLE, type EndUserTokens } from './role-auth.js';
export { makeGate, principalOf, type Gate, type GateOptions } from './gate.js';
export { fromReadWrite, normalizeAuth, bindsIdentity, type ReadWriteAuth } from './adapter.js';
export { safeEqual } from './safe-equal.js';
// One JWT verifier for the free `endUsers` class and every @gnldev/auth-ee SSO provider.
export { verifyJwt, jwtFromRequest, b64uDecode, declaredKind, signSubjectToken, MIN_SUBJECT_SECRET_BYTES, MAX_SUBJECT_TTL_SEC, MAX_REVOCABLE_SUBJECT_TTL_SEC, type JwtVerifyOptions } from './jwt.js';
export { isCrossSiteStateChange } from './same-site.js';
export { subjectTokenEndpoint, sessionTokenId, type SubjectSession } from './token-endpoint.js';
// The one reading a standalone door (chat, AG-UI, MCP) makes of a request: `identify`, then `engineCallerOf`.
export { callerOfRequest, APPLICATION_NAMES_NO_USER, type RequestCaller } from './door.js';
export { PLATFORM_ADMIN_ROLE, isPlatformAdmin, principalScope, callerKind, isPrincipalKind, assertAssignablePrivileges, actorIdOf, isReservedSubjectId, subjectIdProblem, RESERVED_SUBJECT_PREFIXES, engineCallerOf, type PrincipalScope, type AssignabilityResult, type Identify, type EngineCaller } from './scope.js';
// Who may reach a surface that listens on a socket. One decision for every GNL surface that binds
// one; see exposure.ts's header for why @gnldev/cli keeps a pinned second implementation.
export { decideExposure, isLoopbackHost, isPublishedDevCredential, PUBLISHED_DEV_TOKENS, type ExposureInput, type ExposureDecision } from './exposure.js';

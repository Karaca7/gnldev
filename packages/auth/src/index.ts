// @gnldev/auth — open-core auth seam:
// AuthProvider  → stable contract (server + studio gate against this)
//   RoleAuth      → free default (bearer/basic; superAdmin/admin/client/viewer)
//   makeGate      → shared Hono gate (allow/deny)
//   normalizeAuth → AuthProvider | {read,write} backward-compat bridge
export type { Principal, AuthContext, Decision, AuthCapabilities, AuthProvider, Cred } from './types.js';
export { roleAuth, CLIENT_ROLE, CLIENT_WRITES } from './role-auth.js';
export { makeGate, principalOf, type Gate, type GateOptions } from './gate.js';
export { fromReadWrite, normalizeAuth, bindsIdentity, type ReadWriteAuth } from './adapter.js';
export { safeEqual } from './safe-equal.js';
export { isCrossSiteStateChange } from './same-site.js';
export { PLATFORM_ADMIN_ROLE, isPlatformAdmin, principalScope, assertAssignablePrivileges, type PrincipalScope, type AssignabilityResult } from './scope.js';

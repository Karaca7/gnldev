// @gnldev/studio — durable run inspector. Admin↔API split:
//   CreateStudioApi   → JSON only (mount/auth/programmatic)
//   CreateStudioAdmin → HTML UI only (local/remote API via apiBase)
//   CreateStudioApp   → convenience combining both (backward compatible)
export { createStudioApi, createStudioAdmin, createStudioApp, PERMISSION_CATALOG, ROLE_PERMISSION_PRESETS } from './server.js';
export type { FetchHandler, RouteInfo } from './handler.js';
export type {
  StudioApiOptions,
  StudioAppOptions,
  StudioOptions,
  StudioAuth,
  StudioUser,
  StudioUserStore,
  PermissionCatalogEntry,
  StudioResume,
  StudioChat,
  StudioAgentRunner,
  AgentMeta,
  ToolMeta,
  ToolListItem,
  StudioMemory,
  StudioWorkflows,
  WorkflowMeta,
  StudioScorers,
  ScoreRunResultLike,
  StudioDatasets,
  DatasetMeta,
  EvalDatasetResultLike,
  StudioMcpServer,
} from './server.js';
export { createStudioRunner } from './runner.js';
export type { GnlLike, RunnerConfigLike, RunnerAgentLike, RunnerToolLike, MakeRunnerOptions } from './runner.js';
export { pipeAgentStream, interruptsFromSteps } from './sse.js';
export { bearerAuth, basicAuth, roleAuth } from './auth.js';
export type { AuthProvider, Principal, Decision, AuthCapabilities, Cred } from './auth.js';

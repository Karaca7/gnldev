// @gnldev/agui — public export surface. AG-UI (CopilotKit) protocol adapter: zero @ag-ui/* dependency,
// event types hand-defined (see types.ts header note).
export { EventType } from './types.js';
export type {
  BaseAguiEvent,
  AguiEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  CustomEvent,
} from './types.js';

export { toAguiEvents, initialAguiConvertState } from './convert.js';
export type { GnlSseEvent, AguiConvertContext, AguiConvertState, AguiConvertResult } from './convert.js';

export { pipeAguiStream, createAguiRoute } from './route.js';
export type { PipeAguiStreamOptions, CreateAguiRouteOptions } from './route.js';

// AG-UI (https://github.com/ag-ui-protocol/ag-ui — CopilotKit's open agent↔UI event protocol) core
// event types. HONESTY NOTE: this is a hand-extracted TS equivalent of the SUBSET of the known spec we
// need, WITHOUT installing the official `@ag-ui/core` package — not verified against the official
// conformance test. Fields we're not sure about (rawEvent, RunFinishedEvent.result, TextMessageStart.role
// being fixed) are marked in comments; no made-up fields were ADDED.

/** The core type tag carried by all AG-UI events. */
export enum EventType {
  RUN_STARTED = 'RUN_STARTED',
  RUN_FINISHED = 'RUN_FINISHED',
  RUN_ERROR = 'RUN_ERROR',
  TEXT_MESSAGE_START = 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT = 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END = 'TEXT_MESSAGE_END',
  TOOL_CALL_START = 'TOOL_CALL_START',
  TOOL_CALL_ARGS = 'TOOL_CALL_ARGS',
  TOOL_CALL_END = 'TOOL_CALL_END',
  TOOL_CALL_RESULT = 'TOOL_CALL_RESULT',
  /** The spec's general-purpose escape hatch — for signals with no counterpart in the core (see interrupt mapping). */
  CUSTOM = 'CUSTOM',
}

/** Fields common to every event. `timestamp`/`rawEvent` exist in the official spec but we only fill them in when needed. */
export interface BaseAguiEvent {
  type: EventType;
  timestamp?: number;
  /** Escape hatch for extra/raw data that doesn't fit the core schema (e.g. GNL error.detail). */
  rawEvent?: unknown;
}

export interface RunStartedEvent extends BaseAguiEvent {
  type: EventType.RUN_STARTED;
  threadId: string;
  runId: string;
}

export interface RunFinishedEvent extends BaseAguiEvent {
  type: EventType.RUN_FINISHED;
  threadId: string;
  runId: string;
  /** UNCERTAIN: we're not sure whether/what the official spec's field carrying the run result is called —
   *  as a best effort we carry GNL's finishReason/usage here. */
  result?: unknown;
}

export interface RunErrorEvent extends BaseAguiEvent {
  type: EventType.RUN_ERROR;
  message: string;
  code?: string;
}

export interface TextMessageStartEvent extends BaseAguiEvent {
  type: EventType.TEXT_MESSAGE_START;
  messageId: string;
  /** UNCERTAIN: it's not clear from the spec whether the role is always 'assistant' or can vary — since
   *  the text streamed on the GNL side is always agent output, we give a fixed 'assistant'. */
  role?: 'assistant';
}

export interface TextMessageContentEvent extends BaseAguiEvent {
  type: EventType.TEXT_MESSAGE_CONTENT;
  messageId: string;
  delta: string;
}

export interface TextMessageEndEvent extends BaseAguiEvent {
  type: EventType.TEXT_MESSAGE_END;
  messageId: string;
}

export interface ToolCallStartEvent extends BaseAguiEvent {
  type: EventType.TOOL_CALL_START;
  toolCallId: string;
  toolCallName: string;
  /** UNCERTAIN: we're not sure whether the spec has an optional field linking to the assistant message that started the tool call. */
  parentMessageId?: string;
}

export interface ToolCallArgsEvent extends BaseAguiEvent {
  type: EventType.TOOL_CALL_ARGS;
  toolCallId: string;
  /** In the official spec this is an incremental JSON chunk (streaming args) — since GNL's tool-call
   *  gives arguments COMPLETE (not streaming), here the entire JSON is sent in a SINGLE delta (see README note). */
  delta: string;
}

export interface ToolCallEndEvent extends BaseAguiEvent {
  type: EventType.TOOL_CALL_END;
  toolCallId: string;
}

export interface ToolCallResultEvent extends BaseAguiEvent {
  type: EventType.TOOL_CALL_RESULT;
  messageId: string;
  toolCallId: string;
  content: string;
  role?: 'tool';
}

/** For signals with no counterpart in the core (GNL interrupt/HITL is carried here — see README). */
export interface CustomEvent extends BaseAguiEvent {
  type: EventType.CUSTOM;
  name: string;
  value: unknown;
}

export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | CustomEvent;

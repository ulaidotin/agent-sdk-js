/**
 * Build voice agents on the Ulai agent server.
 *
 * Describe an agent once, then connect, and either start a call yourself or
 * take calls as they arrive:
 *
 * ```ts
 * const client = new Client("agent-server:443", { apiKey, tls: true });
 *
 * // Outbound: put the agent in a room and run the call to its end.
 * await client.run({ id: roomId, url: roomUrl, token }, support, handle);
 *
 * // Inbound: run handle on every call for this agent, as each one starts.
 * await client.serve(support.id, support.tools, handle);
 * ```
 *
 * Tool calls are answered for you, in the background. Closing a session, or
 * crashing, detaches from the call: the server carries on without you. A call
 * ends when the caller hangs up, when the model ends it with its end_call
 * tool, or when you call `session.hangup()`. run is the exception: when its
 * handler returns or its signal aborts, it takes the agent out of the room.
 *
 * @module
 */

export {
  CloudAccount,
  validate,
  type Agent,
  type AgentOptions,
  type CloudAccountInit,
  type ValidateOptions,
} from "./agent.js";
export {
  Client,
  type ClientOptions,
  type Handler,
  type Job,
  type JobsOptions,
  type JoinOptions,
  type RunOptions,
  type ServeOptions,
} from "./client.js";
export {
  AgentError,
  AmbiguousParticipantError,
  CallEndedError,
  CallLostError,
  CanceledError,
  DeadlineError,
  EventsInUseError,
  InvalidRequestError,
  NotFoundError,
  NotSupportedError,
  RoomFullError,
  RoomNotFoundError,
  SessionClosedError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
  type AgentErrorOptions,
} from "./errors.js";
export type {
  Ended,
  Event,
  ModelUsage,
  PipelineMetrics,
  Rejected,
  RejectedCommand,
  StateChanged,
  ToolCall,
  ToolOutcome,
  Transcript,
  TurnEnded,
  TurnStarted,
  TurnTokens,
  Usage,
  UsageIO,
} from "./events.js";
export {
  CascadeMode,
  ClassifierBackend,
  Language,
  LLMModel,
  Opening,
  RealtimeModel,
  Role,
  STTModel,
  UlaiLiveVoice,
  VAD,
  Voice,
} from "./models.js";
export {
  Cascade,
  Realtime,
  UlaiLive,
  type CascadeOptions,
  type Pipeline,
  type RealtimeOptions,
  type UlaiLiveOptions,
} from "./pipeline.js";
export { Room, Seat, type LeaveOptions, type LeaveResult, type RoomLike, type SeatInit } from "./room.js";
export { Session, type AttachOptions, type EventsOptions } from "./session.js";
export {
  p,
  tool,
  toolFromSchema,
  type Param,
  type ParamDefinition,
  type Params,
  type ParamSchema,
  type ParamType,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolDefinition,
  type ToolHandler,
} from "./tools.js";
export { AgentState, PipelineKind, Speaker, TurnDetection, type BackendInfo, type CallInfo } from "./types.js";

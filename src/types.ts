import {
  AgentState as PBAgentState,
  Pipeline as PBPipeline,
  Speaker as PBSpeaker,
  TurnDetection as PBTurnDetection,
  type BackendInfo as PBBackendInfo,
  type CallInfo as PBCallInfo,
} from "ulai-agent-protocol/ulai/agent/v1";

type ValueOf<T> = T[keyof T];

/** Who said something. */
export const Speaker = {
  Caller: "caller",
  Agent: "agent",
} as const;
export type Speaker = ValueOf<typeof Speaker>;

/** What the agent is doing. */
export const AgentState = {
  Listening: "listening",
  Thinking: "thinking",
  Speaking: "speaking",
} as const;
export type AgentState = ValueOf<typeof AgentState>;

/** The shape of the pipeline running a call, as the server reports it. */
export const PipelineKind = {
  Realtime: "realtime",
  SemiCascade: "semi-cascade",
  Cascade: "cascade",
} as const;
export type PipelineKind = ValueOf<typeof PipelineKind>;

/** Who decides when the caller has finished speaking. */
export const TurnDetection = {
  /** The model decides. */
  Server: "server",
  /** The engine decides, from voice activity. */
  Client: "client",
} as const;
export type TurnDetection = ValueOf<typeof TurnDetection>;

/** Describes a call. */
export interface CallInfo {
  callId: string;
  agentId: string;
  /** How the call reached the agent: "room" for a call started with join. */
  direction: string;
  /** For a room call, the agent's participant id. */
  from: string;
  /** For a room call, the room id. */
  to: string;
  /** The custom fields the call was started with (`fields`); empty when none. */
  fields: Record<string, unknown>;
}

/** Describes what is running a call. */
export interface BackendInfo {
  provider: string;
  model: string;
  /** Empty when the server did not say. */
  pipeline: PipelineKind | "";
  /** Empty when the server did not say. */
  turnDetection: TurnDetection | "";
}

export function callInfoFrom(p: PBCallInfo | undefined): CallInfo {
  let fields: Record<string, unknown> = {};
  const raw = p?.customFieldsJson ?? "";
  if (raw !== "") {
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        fields = v as Record<string, unknown>;
      }
    } catch {
      // Fields that are not a JSON object read as none, as in the Go SDK.
    }
  }
  return {
    callId: p?.callId ?? "",
    agentId: p?.agentId ?? "",
    direction: p?.direction ?? "",
    from: p?.fromNumber ?? "",
    to: p?.toNumber ?? "",
    fields,
  };
}

export function backendInfoFrom(p: PBBackendInfo | undefined): BackendInfo {
  let pipeline: BackendInfo["pipeline"] = "";
  switch (p?.pipeline) {
    case PBPipeline.REALTIME:
      pipeline = PipelineKind.Realtime;
      break;
    case PBPipeline.SEMI_CASCADE:
      pipeline = PipelineKind.SemiCascade;
      break;
    case PBPipeline.CASCADE:
      pipeline = PipelineKind.Cascade;
      break;
  }
  let turnDetection: BackendInfo["turnDetection"] = "";
  switch (p?.turnDetection) {
    case PBTurnDetection.SERVER:
      turnDetection = TurnDetection.Server;
      break;
    case PBTurnDetection.CLIENT:
      turnDetection = TurnDetection.Client;
      break;
  }
  return { provider: p?.provider ?? "", model: p?.model ?? "", pipeline, turnDetection };
}

export function speakerFrom(p: PBSpeaker): Speaker | "" {
  switch (p) {
    case PBSpeaker.CALLER:
      return Speaker.Caller;
    case PBSpeaker.AGENT:
      return Speaker.Agent;
    default:
      return "";
  }
}

export function agentStateFrom(p: PBAgentState): AgentState | "" {
  switch (p) {
    case PBAgentState.LISTENING:
      return AgentState.Listening;
    case PBAgentState.THINKING:
      return AgentState.Thinking;
    case PBAgentState.SPEAKING:
      return AgentState.Speaking;
    default:
      return "";
  }
}

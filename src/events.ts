import type {
  ModalityTokens as PBModalityTokens,
  PipelineMetrics as PBPipelineMetrics,
  ServerEvent,
  ToolCall as PBToolCall,
  TurnTokens as PBTurnTokens,
  UsageIO as PBUsageIO,
} from "ulai-agent-protocol/ulai/agent/v1";

import { agentStateFrom, speakerFrom, type AgentState, type Speaker } from "./types.js";

/**
 * Something that happened on a call. Switch on `type`:
 *
 * - `transcript`: something was said
 * - `turnStarted`: someone started speaking
 * - `turnEnded`: someone finished, with what they said and what it cost
 * - `stateChanged`: the agent started listening, thinking or speaking
 * - `toolCall`: the model called a tool
 * - `toolOutcome`: the server answered one of its own tools
 * - `usage`: running token counts
 * - `rejected`: a command this client sent could not be applied
 * - `ended`: the call is over; no events follow
 *
 * Every event has `elapsedMs`: how far into the call it happened.
 */
export type Event =
  Transcript | TurnStarted | TurnEnded | StateChanged | ToolCall | ToolOutcome | Usage | Rejected | Ended;

/**
 * Something said on the call. Partial transcripts arrive while someone is
 * still speaking; the final one has `final` set.
 */
export interface Transcript {
  readonly type: "transcript";
  readonly elapsedMs: number;
  readonly speaker: Speaker | "";
  readonly text: string;
  readonly final: boolean;
}

/** Someone starting to speak. */
export interface TurnStarted {
  readonly type: "turnStarted";
  readonly elapsedMs: number;
  readonly speaker: Speaker | "";
  readonly turnId: string;
}

/** Someone finishing a turn. */
export interface TurnEnded {
  readonly type: "turnEnded";
  readonly elapsedMs: number;
  readonly speaker: Speaker | "";
  readonly turnId: string;
  /** What the caller heard of the turn. */
  readonly text: string;
  readonly durationMs: number;
  readonly interrupted: boolean;
  /**
   * How much of an agent turn the caller actually heard, which is less than
   * `durationMs` when they interrupted it.
   */
  readonly heardMs: number;
  /** What the model wrote for the turn. `text` is what the caller heard of it. */
  readonly generated: string;
  readonly audioBytes: number;
  /** How many characters were sent to text-to-speech. */
  readonly ttsChars: number;
  readonly toolCalls: readonly ToolCall[];
  /** The model's own usage report for the turn, when it gave one. */
  readonly tokens: TurnTokens | undefined;
}

/** One turn's token usage. */
export interface TurnTokens {
  readonly promptTotal: number;
  readonly promptCached: number;
  /** By modality: "audio", "text". */
  readonly prompt: Readonly<Record<string, number>>;
  readonly responseTotal: number;
  readonly response: Readonly<Record<string, number>>;
  readonly total: number;
  readonly reasoning: number;
  readonly toolPrompt: number;
}

/** The agent starting to listen, think or speak. */
export interface StateChanged {
  readonly type: "stateChanged";
  readonly elapsedMs: number;
  readonly state: AgentState | "";
}

/**
 * The model calling a tool. A tool with a handler is answered for you; the
 * event is still delivered so you can see it.
 */
export interface ToolCall {
  readonly type: "toolCall";
  readonly elapsedMs: number;
  readonly id: string;
  readonly name: string;
  /** The arguments, parsed; undefined when there were none or they were not JSON. */
  readonly args: unknown;
  /** The arguments as the model sent them. */
  readonly argsJson: string;
}

/** The server answering one of its own tools, such as end_call. */
export interface ToolOutcome {
  readonly type: "toolOutcome";
  readonly elapsedMs: number;
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly argsJson: string;
  /** The result, parsed; undefined when there was none or it was not JSON. */
  readonly result: unknown;
  readonly resultJson: string;
  readonly error: string;
  readonly errorCode: string;
}

/** The call's running token counts. */
export interface Usage {
  readonly type: "usage";
  readonly elapsedMs: number;
  readonly promptTotal: number;
  readonly promptCached: number;
  readonly responseTotal: number;
  readonly prompt: Readonly<Record<string, number>>;
  readonly response: Readonly<Record<string, number>>;
  /**
   * The usage per model: one for a realtime call, one per stage for a
   * cascade, plus answering-machine detection when it ran.
   */
  readonly models: readonly ModelUsage[];
}

/** One model's share of a call's usage. */
export interface ModelUsage {
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly unit: string;
  readonly audio: UsageIO;
  readonly text: UsageIO;
}

/** Input, cached input and output, in {@link ModelUsage.unit}. */
export interface UsageIO {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

/** A command a {@link Rejected} event can name. */
export type RejectedCommand = "reply" | "injectContext" | "interrupt" | "hangup" | "toolResult" | "handledTools";

/** The server refusing a command this client sent. The call goes on. */
export interface Rejected {
  readonly type: "rejected";
  readonly elapsedMs: number;
  /** The command refused; empty when it cannot be told. */
  readonly command: RejectedCommand | "";
  readonly message: string;
}

/** The call ending. It is the last event. */
export interface Ended {
  readonly type: "ended";
  readonly elapsedMs: number;
  /** Which side ended the call. */
  readonly reason: string;
  readonly disposition: string;
  readonly durationMs: number;
  /** How much agent audio the caller heard. */
  readonly heardMs: number;
  /**
   * Why, in the server's words: ended, terminated, max_duration, no_response,
   * CALL_FAILED.
   */
  readonly endReason: string;
  /** The call's latency figures, when the server kept them. */
  readonly pipeline: PipelineMetrics | undefined;
}

/** A call's latency and backpressure. */
export interface PipelineMetrics {
  readonly ttfbAvgMs: number;
  readonly ttfbP50Ms: number;
  readonly ttfbP95Ms: number;
  readonly ttfbP99Ms: number;
  readonly ttfbMinMs: number;
  readonly ttfbMaxMs: number;
  readonly userTurns: number;
  readonly agentTurns: number;
  readonly interruptedTurns: number;
  readonly userSpeakingMs: number;
  readonly agentSpeakingMs: number;
  readonly inboundFrames: number;
  readonly inboundAvgMs: number;
  readonly inboundMaxMs: number;
  readonly outboundChunks: number;
  readonly outboundAvgMs: number;
  readonly outboundMaxMs: number;
  /**
   * Frames dropped, by stage: input_filter, to_model, from_model,
   * model_write, provider_send, provider_receive, recording.
   */
  readonly droppedByStage: Readonly<Record<string, number>> | undefined;
}

const num = (v: bigint | number): number => Number(v);

function parseJSON(raw: string): unknown {
  if (raw === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function modalities(list: readonly PBModalityTokens[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of list) {
    out[m.modality] = num(m.tokens);
  }
  return out;
}

function usageIO(u: PBUsageIO | undefined): UsageIO {
  return { input: num(u?.input ?? 0n), cached: num(u?.cached ?? 0n), output: num(u?.output ?? 0n) };
}

function turnTokens(t: PBTurnTokens | undefined): TurnTokens | undefined {
  if (!t) {
    return undefined;
  }
  return {
    promptTotal: num(t.promptTotal),
    promptCached: num(t.promptCached),
    prompt: modalities(t.prompt),
    responseTotal: num(t.responseTotal),
    response: modalities(t.response),
    total: num(t.total),
    reasoning: num(t.reasoning),
    toolPrompt: num(t.toolPrompt),
  };
}

function toolCall(elapsedMs: number, c: PBToolCall): ToolCall {
  return { type: "toolCall", elapsedMs, id: c.id, name: c.name, args: parseJSON(c.argsJson), argsJson: c.argsJson };
}

function pipelineMetrics(m: PBPipelineMetrics | undefined): PipelineMetrics | undefined {
  if (!m) {
    return undefined;
  }
  const d = m.drops;
  return {
    ttfbAvgMs: m.ttfbAvgMs,
    ttfbP50Ms: m.ttfbP50Ms,
    ttfbP95Ms: m.ttfbP95Ms,
    ttfbP99Ms: m.ttfbP99Ms,
    ttfbMinMs: m.ttfbMinMs,
    ttfbMaxMs: m.ttfbMaxMs,
    userTurns: m.userTurns,
    agentTurns: m.agentTurns,
    interruptedTurns: m.interruptedTurns,
    userSpeakingMs: m.userSpeakingMs,
    agentSpeakingMs: m.agentSpeakingMs,
    inboundFrames: num(m.inboundFramesTotal),
    inboundAvgMs: m.inboundAvgUs / 1000,
    inboundMaxMs: num(m.inboundMaxUs) / 1000,
    outboundChunks: num(m.outboundChunksTotal),
    outboundAvgMs: m.outboundAvgUs / 1000,
    outboundMaxMs: num(m.outboundMaxUs) / 1000,
    droppedByStage: d
      ? {
          input_filter: num(d.inputFilter),
          to_model: num(d.toModel),
          from_model: num(d.fromModel),
          model_write: num(d.modelWrite),
          provider_send: num(d.providerSend),
          provider_receive: num(d.providerReceive),
          recording: num(d.recording),
        }
      : undefined,
  };
}

/**
 * eventFrom turns a server event into the SDK's, or undefined for one a client
 * does not see (SessionStarted, or a kind this SDK does not know).
 * commandFor names the command a rejection refers to.
 */
export function eventFrom(
  ev: ServerEvent,
  commandFor: (sequenceRef: bigint) => RejectedCommand | "" = () => "",
): Event | undefined {
  const elapsedMs = num(ev.elapsedMs);
  const e = ev.event;
  switch (e.case) {
    case "transcript":
      return {
        type: "transcript",
        elapsedMs,
        speaker: speakerFrom(e.value.speaker),
        text: e.value.text,
        final: e.value.final,
      };

    case "turnStarted":
      return { type: "turnStarted", elapsedMs, speaker: speakerFrom(e.value.speaker), turnId: e.value.turnId };

    case "turnEnded": {
      const t = e.value;
      return {
        type: "turnEnded",
        elapsedMs,
        speaker: speakerFrom(t.speaker),
        turnId: t.turnId,
        text: t.transcript,
        durationMs: t.durationMs,
        interrupted: t.interrupted,
        heardMs: t.heardMs ?? 0,
        generated: t.generated,
        audioBytes: num(t.audioBytes),
        ttsChars: num(t.ttsCharacters),
        toolCalls: t.toolCalls.map((c) => toolCall(elapsedMs, c)),
        tokens: turnTokens(t.tokens),
      };
    }

    case "agentState":
      return { type: "stateChanged", elapsedMs, state: agentStateFrom(e.value.state) };

    case "toolCall":
      return toolCall(elapsedMs, e.value);

    case "toolOutcome": {
      const o = e.value;
      return {
        type: "toolOutcome",
        elapsedMs,
        id: o.id,
        name: o.name,
        args: parseJSON(o.argsJson),
        argsJson: o.argsJson,
        result: parseJSON(o.resultJson),
        resultJson: o.resultJson,
        error: o.error,
        errorCode: o.errorCode,
      };
    }

    case "usage": {
      const u = e.value;
      return {
        type: "usage",
        elapsedMs,
        promptTotal: num(u.promptTotal),
        promptCached: num(u.promptCached),
        responseTotal: num(u.responseTotal),
        prompt: modalities(u.prompt),
        response: modalities(u.response),
        models: u.models.map((m) => ({
          role: m.role,
          provider: m.provider,
          model: m.model,
          unit: m.unit,
          audio: usageIO(m.audio),
          text: usageIO(m.text),
        })),
      };
    }

    case "error":
      return { type: "rejected", elapsedMs, command: commandFor(e.value.sequenceRef), message: e.value.message };

    case "sessionEnded": {
      const s = e.value;
      return {
        type: "ended",
        elapsedMs,
        reason: s.reason,
        disposition: s.disposition,
        durationMs: num(s.durationMs),
        heardMs: num(s.playedMs),
        endReason: s.endReason,
        pipeline: pipelineMetrics(s.pipelineMetrics),
      };
    }

    default:
      return undefined;
  }
}

import { create } from "@bufbuild/protobuf";
import { CascadeConfigSchema, SpeechServiceConfigSchema, type AgentProfile } from "ulai-agent-protocol/ulai/agent/v1";

import {
  backendGeminiLive,
  backendGoogleCascade,
  backendUlaiLive,
  cascadeModes,
  languages,
  llmModels,
  realtimeBackends,
  RealtimeModel,
  sttRegions,
  ulaiLiveVoices,
  vads,
  voices,
  type CascadeMode,
  type Language,
  type LLMModel,
  type STTModel,
  type UlaiLiveVoice,
  type VAD,
  type Voice,
} from "./models.js";
import { checkCount, checkDuration, checkRange, quote } from "./check.js";

/** How an agent hears and speaks: {@link Realtime}, {@link Cascade} or {@link UlaiLive}. */
export type Pipeline = Realtime | Cascade | UlaiLive;

/** Options for {@link Realtime}. */
export interface RealtimeOptions {
  /** The speech-to-speech model. Default: `RealtimeModel.GeminiLive25FlashNativeAudio`. */
  model?: RealtimeModel;
}

/**
 * Runs the call on one speech-to-speech model, which hears the caller and
 * answers in its own voice. The lowest latency, and the server's default.
 */
export class Realtime {
  readonly kind = "realtime" as const;
  /** The speech-to-speech model. Default: `RealtimeModel.GeminiLive25FlashNativeAudio`. */
  readonly model: RealtimeModel | undefined;

  constructor(options: RealtimeOptions = {}) {
    this.model = options.model;
  }
}

/**
 * Options for {@link Cascade}. Every field is optional: undefined, or zero for
 * a number, is the server's default.
 */
export interface CascadeOptions {
  /** How the cascade hears the caller. Default: `CascadeMode.STT`. */
  mode?: CascadeMode;

  /** The text model. Default: `LLMModel.Gemini25Flash`. */
  llm?: LLMModel;
  /** The region the text model runs in. */
  llmRegion?: string;
  /** Lets the text model think before answering. Slower. */
  llmThinking?: boolean;
  /** The text model's temperature, 0 to 2, when the agent's `temperature` is not set. */
  llmTemperature?: number;

  /** The speech-to-text model. Default: `STTModel.Short`. */
  stt?: STTModel;
  /** The region speech-to-text runs in. Default: the region the model is served from. */
  sttRegion?: string;
  /** The languages to listen for. Several turn on language detection. Default: the agent's language. */
  sttLanguages?: readonly Language[];
  /** Words speech-to-text should favour: names, products. */
  keywords?: readonly string[];

  /** The speaking voice. Default: the agent's voice. */
  ttsVoice?: Voice;
  /** The region text-to-speech runs in. */
  ttsRegion?: string;
  /** The speaking language when the agent's language is not set. */
  ttsLanguage?: Language;
  /** The speech sample rate in Hz. Default: 24000. */
  ttsSampleRate?: number;

  /** The voice-activity detector the caller's audio is gated with. */
  vad?: VAD;
  /** The detector's confidence threshold, 0 to 1. */
  vadConfidence?: number;
  /** The detector's minimum volume, 0 to 1. */
  vadMinVolume?: number;

  /** Uses a model, not just silence, to decide when the caller has finished speaking. */
  turnModel?: boolean;
  /** Ends the caller's turn after this much silence even when the turn model is unsure. */
  turnModelMaxSilenceMs?: number;

  /** How long to wait for the final transcript. */
  transcriptWaitMs?: number;
  /** Silence that ends an utterance. */
  endpointSilenceMs?: number;
  /** Shorter speech is ignored. */
  minUtteranceMs?: number;
  /** Longer speech is cut into turns. */
  maxUtteranceMs?: number;
  /** Audio kept from before speech was detected. */
  prefixPadMs?: number;

  /** How many turns of the conversation the text model sees. Zero is the default. */
  maxHistoryTurns?: number;
}

export interface Cascade extends Readonly<CascadeOptions> {}

/**
 * Runs the call in three stages: speech-to-text, a text model, then
 * text-to-speech. More control over each stage than {@link Realtime}, for some
 * extra latency per turn.
 */
export class Cascade {
  readonly kind = "cascade" as const;

  constructor(options: CascadeOptions = {}) {
    Object.assign(this, options);
    if (options.sttLanguages) {
      Object.assign(this, { sttLanguages: Object.freeze([...options.sttLanguages]) });
    }
    if (options.keywords) {
      Object.assign(this, { keywords: Object.freeze([...options.keywords]) });
    }
  }
}

/** Options for {@link UlaiLive}. */
export interface UlaiLiveOptions {
  /** The API's host, e.g. "live.example.com". Empty is the server's default. */
  url?: string;
  /** Dials without TLS. Local testing only. */
  insecure?: boolean;
  /** The speaking voice. Default: `UlaiLiveVoice.Alba`. */
  voice?: UlaiLiveVoice;
  /** The sample rate the API sends audio at, in Hz. */
  outputRate?: number;
}

/** Runs the call on the Ulai Live API. */
export class UlaiLive {
  readonly kind = "ulai-live" as const;
  readonly url: string | undefined;
  readonly insecure: boolean | undefined;
  readonly voice: UlaiLiveVoice | undefined;
  readonly outputRate: number | undefined;

  constructor(options: UlaiLiveOptions = {}) {
    this.url = options.url;
    this.insecure = options.insecure;
    this.voice = options.voice;
    this.outputRate = options.outputRate;
  }
}

/** The pipeline's kind, or undefined for something that is not one. */
export function pipelineKind(p: unknown): Pipeline["kind"] | undefined {
  if (typeof p !== "object" || p === null) {
    return undefined;
  }
  const kind = (p as { kind?: unknown }).kind;
  return kind === "realtime" || kind === "cascade" || kind === "ulai-live" ? kind : undefined;
}

function realtimeModel(r: Realtime): string {
  return r.model || RealtimeModel.GeminiLive25FlashNativeAudio;
}

/**
 * Every problem with a pipeline. lists says whether models, voices and the
 * other listed values must be ones this SDK knows.
 */
export function pipelineProblems(p: Pipeline, lists: boolean): string[] {
  const problems: string[] = [];
  switch (pipelineKind(p)) {
    case "realtime": {
      const r = p as Realtime;
      if (lists && !realtimeBackends.has(realtimeModel(r))) {
        problems.push(`unknown RealtimeModel ${quote(r.model)}: use one of the RealtimeModel constants`);
      }
      break;
    }
    case "cascade": {
      const c = p as Cascade;
      const add = (s: string) => problems.push(`Cascade: ${s}`);
      checkRange("llmTemperature", c.llmTemperature, 0, 2, add);
      if (lists) {
        if (c.mode && !cascadeModes.has(c.mode)) {
          add(`unknown mode ${quote(c.mode)}: use CascadeMode.STT or CascadeMode.Audio`);
        }
        if (c.llm && !llmModels.has(c.llm)) {
          add(`unknown llm ${quote(c.llm)}: use one of the LLMModel constants`);
        }
        if (c.stt && !sttRegions.has(c.stt)) {
          add(`unknown stt ${quote(c.stt)}: use one of the STTModel constants`);
        }
        for (const l of c.sttLanguages ?? []) {
          if (!languages.has(l)) {
            add(`unknown sttLanguages entry ${quote(l)}: use the Language constants`);
          }
        }
        if (c.ttsVoice && !voices.has(c.ttsVoice)) {
          add(`unknown ttsVoice ${quote(c.ttsVoice)}: use one of the Voice constants`);
        }
        if (c.ttsLanguage && !languages.has(c.ttsLanguage)) {
          add(`unknown ttsLanguage ${quote(c.ttsLanguage)}: use one of the Language constants`);
        }
        if (c.vad && !vads.has(c.vad)) {
          add(`unknown vad ${quote(c.vad)}: use VAD.Silero or VAD.Ten`);
        }
      }
      // The numbers, which no server could accept out of range whatever its lists.
      checkRange("vadConfidence", c.vadConfidence, 0, 1, add);
      checkRange("vadMinVolume", c.vadMinVolume, 0, 1, add);
      checkCount("ttsSampleRate", c.ttsSampleRate, add);
      checkCount("maxHistoryTurns", c.maxHistoryTurns, add);
      for (const name of [
        "turnModelMaxSilenceMs",
        "transcriptWaitMs",
        "endpointSilenceMs",
        "minUtteranceMs",
        "maxUtteranceMs",
        "prefixPadMs",
      ] as const) {
        checkDuration(name, c[name], add);
      }
      break;
    }
    case "ulai-live": {
      const u = p as UlaiLive;
      const add = (s: string) => problems.push(`UlaiLive: ${s}`);
      if (lists && u.voice && !ulaiLiveVoices.has(u.voice)) {
        add(`unknown voice ${quote(u.voice)}: use one of the UlaiLiveVoice constants`);
      }
      checkCount("outputRate", u.outputRate, add);
      break;
    }
    default:
      problems.push("Agent.pipeline must be a Realtime, Cascade or UlaiLive (or undefined for the server's default)");
  }
  return problems;
}

/** optMs is ms as a whole number of milliseconds, or undefined for zero so the server keeps its default. */
function optMs(ms: number | undefined): number | undefined {
  if (!ms) {
    return undefined;
  }
  return Math.max(Math.trunc(ms), 1);
}

/** optInt is v, or undefined for zero so the server keeps its default. */
function optInt(v: number | undefined): number | undefined {
  return v ? Math.trunc(v) : undefined;
}

/** applyPipeline sets the profile fields that say how the call runs. */
export function applyPipeline(p: Pipeline, profile: AgentProfile): void {
  switch (p.kind) {
    case "realtime": {
      const model = realtimeModel(p);
      // An unlisted model (allowUnlistedValues): the realtime backend.
      profile.aiBackend = realtimeBackends.get(model) ?? backendGeminiLive;
      profile.model = model;
      return;
    }
    case "cascade": {
      profile.aiBackend = backendGoogleCascade;
      const cc = create(CascadeConfigSchema, {
        mode: p.mode ?? "",
        llmModel: p.llm ?? "",
        llmRegion: p.llmRegion ?? "",
        llmThinking: p.llmThinking,
        llmTemperature: p.llmTemperature,
        sttModel: p.stt ?? "",
        sttRegion: p.sttRegion ?? "",
        sttLanguages: [...(p.sttLanguages ?? [])],
        sttKeywords: [...(p.keywords ?? [])],
        ttsVoice: p.ttsVoice ?? "",
        ttsRegion: p.ttsRegion ?? "",
        ttsLanguage: p.ttsLanguage ?? "",
        ttsRate: optInt(p.ttsSampleRate),
        vad: p.vad ?? "",
        vadConfidence: p.vadConfidence,
        vadMinVolume: p.vadMinVolume,
        turnModel: p.turnModel,
        turnModelMaxSilenceMs: optMs(p.turnModelMaxSilenceMs),
        transcriptWaitMs: optMs(p.transcriptWaitMs),
        endpointSilenceMs: optMs(p.endpointSilenceMs),
        minUtteranceMs: optMs(p.minUtteranceMs),
        maxUtteranceMs: optMs(p.maxUtteranceMs),
        prefixPadMs: optMs(p.prefixPadMs),
        maxHistoryTurns: optInt(p.maxHistoryTurns),
      });
      // A model only works in some regions, so naming one without a region
      // would fail on the call. Fill in the region it is served from.
      if (cc.sttRegion === "" && p.stt) {
        cc.sttRegion = sttRegions.get(p.stt) ?? "";
      }
      profile.cascade = cc;
      return;
    }
    case "ulai-live":
      profile.aiBackend = backendUlaiLive;
      profile.speechService = create(SpeechServiceConfigSchema, {
        url: p.url ?? "",
        insecure: p.insecure ?? false,
        voice: p.voice ?? "",
        outputRate: optInt(p.outputRate),
      });
      return;
  }
}

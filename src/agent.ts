import { readFile } from "node:fs/promises";
import { inspect, type InspectOptionsStylized } from "node:util";

import { create } from "@bufbuild/protobuf";
import { AgentProfileSchema, OpeningTurn, type AgentProfile } from "ulai-agent-protocol/ulai/agent/v1";

import { checkDuration, checkRange, maxInt32, quote } from "./check.js";
import { AgentError, ValidationError } from "./errors.js";
import {
  classifiers,
  languages,
  Opening,
  voices,
  type ClassifierBackend,
  type Language,
  type Voice,
} from "./models.js";
import { applyPipeline, pipelineKind, pipelineProblems, type Pipeline } from "./pipeline.js";
import { toolProblems, toolSpec, type Tool } from "./tools.js";

/**
 * Everything a voice agent is: who it is, how it sounds, how it hears and
 * speaks, and what it can do.
 *
 * The server keeps no agents of its own, so this travels with every call. A
 * field left undefined means "the server's default".
 */
export interface Agent {
  /** Names the agent. Required. */
  id: string;
  /** Who the agent is and how it behaves: the system prompt. Required. */
  instructions: string;
  /** The agent's opening line. */
  greeting?: string;
  /** The agent's last line. */
  closing?: string;
  /**
   * Extra character, given to the model silently after the greeting rather
   * than in the instructions, which keeps the first turn short.
   */
  persona?: string;
  /**
   * The language a Cascade listens and speaks in. Default: en-IN. A Realtime
   * model takes its language from the conversation, so for one, say which
   * language to use in the instructions.
   */
  language?: Language;
  /** The agent's voice, for Realtime and a Cascade's speech. UlaiLive has its own. */
  voice?: Voice;
  /** How the agent hears and speaks. Undefined is the server's default, Realtime. */
  pipeline?: Pipeline;
  /** What the agent can do: each is shown to the model and, with a handler, answered by this client. */
  tools?: readonly Tool[];
  /** Who speaks first. Default: the agent. */
  opening?: Opening;
  /** Ends the call after this long. Zero or undefined is the server's limit; otherwise at least 1000. */
  maxDurationMs?: number;
  /** The model's sampling temperature, 0 to 2. Undefined is the server's default, low to keep calls on script. */
  temperature?: number;
  /**
   * The Google Cloud project the models run in, and its key. Required for
   * Realtime and Cascade: the server holds no model credentials of its own.
   * Load one with {@link CloudAccount.fromFile}.
   */
  cloud?: CloudAccount;
  /** Fine-tuning for the call. Undefined throughout is the server's defaults. */
  options?: AgentOptions;
}

/**
 * Fine-tuning for a call. Every field is optional: undefined means the
 * server's default.
 */
export interface AgentOptions {
  /** Lets the caller talk over the agent. Default: yes. */
  interruptible?: boolean;
  /** Lets the caller talk over the greeting. Default: yes. */
  greetingInterruptible?: boolean;
  /** How long to wait for the caller's first words. */
  firstWordsTimeoutMs?: number;
  /**
   * Keeps short acknowledgements ("hmm", "okay") from interrupting the agent,
   * while longer speech still does. Default: on.
   */
  backchannelGate?: boolean;
  /** Nudges a caller who goes quiet, and hangs up after a long silence. Default: decided by the pipeline. */
  silenceMonitor?: boolean;
  /**
   * Lets the model hang up by itself, with an end_call tool the server gives
   * it. Default: on. Declaring your own end_call tool replaces the server's.
   */
  endCallTool?: boolean;
  /** Ends outbound calls that reach a voicemail greeting. */
  voicemailDetection?: boolean;
  /** Re-sends what the caller said while the model was reconnecting. */
  replayLostUtterances?: boolean;
  /** Mixes an ambient bed under the agent's voice. */
  backgroundNoise?: boolean;
  /** Publishes the conversation into the room as captions while it happens. */
  liveTranscription?: boolean;
  /** Lets a long call drop its oldest turns instead of running out of context. */
  contextCompression?: boolean;
  /** Turns off all caller-audio processing except the denoiser. A diagnostic. */
  minimalAudioProcessing?: boolean;
  /** Judges what answered a dialled call. */
  classifier?: ClassifierBackend;
  /** The account the call belongs to, passed through to the server untouched. */
  workspaceId?: string;
}

/** What a {@link CloudAccount} is made from. */
export interface CloudAccountInit {
  /** The project ID. Required. */
  project: string;
  /**
   * Where a Realtime model runs. Default: us-central1. A Cascade sets its
   * regions per stage instead.
   */
  region?: string;
  /** A service-account key for the project, as JSON. Required. */
  credentialsJson: string;
}

const redacted = (secret: string): string => (secret === "" ? "" : "[redacted]");

/**
 * The Google Cloud project an agent's models run in, and its key. It is sent
 * with every call, so connect with TLS anywhere but your own machine.
 *
 * The key is kept out of `toString()`, `JSON.stringify` and `console.log`.
 */
export class CloudAccount {
  /** The project ID. */
  readonly project: string;
  /** Where a Realtime model runs. Empty is the server's default, us-central1. */
  readonly region: string;
  readonly #credentialsJson: string;

  constructor(init: CloudAccountInit) {
    this.project = init.project;
    this.region = init.region ?? "";
    this.#credentialsJson = init.credentialsJson;
  }

  /** The service-account key, as JSON. */
  get credentialsJson(): string {
    return this.#credentialsJson;
  }

  /** Reads a service-account key file into a CloudAccount. */
  static async fromFile(project: string, region: string | undefined, keyFile: string): Promise<CloudAccount> {
    let text: string;
    try {
      text = await readFile(keyFile, "utf8");
    } catch (err) {
      throw new AgentError(`reading the service-account key: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    let type: unknown;
    try {
      type = (JSON.parse(text) as { type?: unknown } | null)?.type;
    } catch {
      type = undefined;
    }
    if (typeof type !== "string" || type === "") {
      throw new AgentError(`${keyFile} is not a service-account key file`);
    }
    return new CloudAccount({ project, region, credentialsJson: text });
  }

  toString(): string {
    return `CloudAccount{project:${this.project} region:${this.region} credentialsJson:${redacted(this.#credentialsJson)}}`;
  }

  toJSON(): { project: string; region: string; credentialsJson: string } {
    return { project: this.project, region: this.region, credentialsJson: redacted(this.#credentialsJson) };
  }

  [inspect.custom](_depth: number, options: InspectOptionsStylized, show: typeof inspect): string {
    return `CloudAccount ${show(this.toJSON(), options)}`;
  }
}

/** Options for {@link validate}. */
export interface ValidateOptions {
  /**
   * Accepts models, voices, languages and the other listed values even when
   * this SDK does not know them, leaving the server to refuse a bad one.
   * Ranges and structure are still checked.
   */
  allowUnlistedValues?: boolean;
}

/**
 * Checks an agent, throwing a {@link ValidationError} that lists every problem.
 * join and run call it for you; call it yourself to check an agent at startup.
 */
export function validate(agent: Agent, options: ValidateOptions = {}): void {
  const problems = agentProblems(agent, !options.allowUnlistedValues);
  if (problems.length > 0) {
    throw new ValidationError(problems);
  }
}

/** needsCloud reports whether a's calls reach Google models, which need the agent's own credentials. */
function needsCloud(a: Agent): boolean {
  if (pipelineKind(a.pipeline) === "ulai-live") {
    // Voicemail detection still asks a Google model.
    return a.options?.voicemailDetection === true;
  }
  return true;
}

/**
 * Every problem with an agent. lists says whether models, voices, languages
 * and the other listed values must be ones this SDK knows.
 */
export function agentProblems(a: Agent, lists: boolean): string[] {
  if (typeof a !== "object" || a === null) {
    return ["the agent must be an object"];
  }
  const problems: string[] = [];
  const add = (s: string) => problems.push(s);

  if (typeof a.id !== "string" || a.id === "") {
    add("Agent.id is required");
  }
  if (typeof a.instructions !== "string" || a.instructions === "") {
    add("Agent.instructions is required: the server keeps no agents, so they travel with every call");
  }
  const cloud = a.cloud;
  if (needsCloud(a) && (!cloud || !cloud.project || !cloud.credentialsJson)) {
    add(
      "Agent.cloud needs a project and credentialsJson: the server holds no model credentials of its own (load a key with CloudAccount.fromFile)",
    );
  }
  if (lists && a.language && !languages.has(a.language)) {
    add(`unknown language ${quote(a.language)}: use one of the Language constants`);
  }
  if (lists && a.voice && !voices.has(a.voice)) {
    add(`unknown voice ${quote(a.voice)}: use one of the Voice constants`);
  }
  const opening = a.opening as unknown;
  if (opening !== undefined && opening !== "" && opening !== Opening.Agent && opening !== Opening.Caller) {
    add(`unknown opening ${quote(opening)}: use Opening.Agent or Opening.Caller`);
  }
  checkRange("temperature", a.temperature, 0, 2, add);
  const maxMs = a.maxDurationMs;
  if (maxMs !== undefined) {
    if (typeof maxMs !== "number" || Number.isNaN(maxMs) || maxMs < 0 || (maxMs > 0 && maxMs < 1000)) {
      add(`maxDurationMs ${quote(maxMs)} must be zero (the server's limit) or at least 1000`);
    } else if (maxMs >= (maxInt32 + 1) * 1000) {
      add(`maxDurationMs ${maxMs} is too long`);
    }
  }
  if (a.pipeline !== undefined) {
    problems.push(...pipelineProblems(a.pipeline, lists));
  }
  const o = a.options;
  if (o !== undefined && (typeof o !== "object" || o === null)) {
    add("Agent.options must be an object");
  } else if (o) {
    checkDuration("options.firstWordsTimeoutMs", o.firstWordsTimeoutMs, add);
    if (lists && o.classifier && !classifiers.has(o.classifier)) {
      add(`unknown options.classifier ${quote(o.classifier)}: use one of the ClassifierBackend constants`);
    }
  }
  problems.push(...toolProblems(a.tools, "Agent.tools"));
  return problems;
}

/** The proto value for who speaks first. */
export function openingToPB(o: Opening | "" | undefined): OpeningTurn {
  switch (o) {
    case Opening.Agent:
      return OpeningTurn.AGENT;
    case Opening.Caller:
      return OpeningTurn.CALLER;
    default:
      return OpeningTurn.UNSPECIFIED;
  }
}

/** The agent on the wire. */
export function agentProfile(a: Agent): AgentProfile {
  const o = a.options ?? {};
  const p = create(AgentProfileSchema, {
    prompt: a.instructions,
    greeting: a.greeting ?? "",
    closing: a.closing ?? "",
    personaText: a.persona ?? "",
    voice: a.voice ?? "",
    language: a.language ?? "",
    temperature: a.temperature,
    maxCallDurationSeconds: Math.trunc((a.maxDurationMs ?? 0) / 1000),
    opening: openingToPB(a.opening),
    allowInterruptions: o.interruptible,
    greetingInterruptible: o.greetingInterruptible,
    initialEngagementDeadlineMs: Math.trunc(o.firstWordsTimeoutMs ?? 0),
    backchannelGate: o.backchannelGate,
    silenceMonitor: o.silenceMonitor,
    endCallEnabled: o.endCallTool,
    amdEnabled: o.voicemailDetection,
    lostUtteranceReplay: o.replayLostUtterances,
    backgroundNoise: o.backgroundNoise ?? false,
    liveTranscription: o.liveTranscription ?? false,
    contextCompression: o.contextCompression ?? false,
    minimalAudioProcessing: o.minimalAudioProcessing,
    aiClassifyBackend: o.classifier ?? "",
    workspaceId: o.workspaceId ?? "",
    tools: (a.tools ?? []).map(toolSpec),
  });
  if (a.cloud) {
    p.providerProject = a.cloud.project;
    p.providerRegion = a.cloud.region ?? "";
    p.providerCredentials = a.cloud.credentialsJson;
  }
  if (a.pipeline !== undefined) {
    applyPipeline(a.pipeline, p);
  }
  return p;
}

// The agent: validation, and how it travels in a JoinRoomRequest.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { format, inspect } from "node:util";

import { OpeningTurn, type JoinRoomRequest } from "ulai-agent-protocol/ulai/agent/v1";

import {
  AgentError,
  Cascade,
  CascadeMode,
  ClassifierBackend,
  CloudAccount,
  Language,
  LLMModel,
  Opening,
  Realtime,
  RealtimeModel,
  Room,
  STTModel,
  UlaiLive,
  UlaiLiveVoice,
  VAD,
  ValidationError,
  Voice,
  p,
  tool,
  toolFromSchema,
  validate,
  type Agent,
} from "../dist/index.js";
import { room, start } from "./fake-server.js";

const opts = { timeout: 15_000 };
const f32 = Math.fround;

const checkBalance = tool({
  name: "check_balance",
  description: "Look up a balance.",
  parameters: {
    account: p.string("The account number."),
    kind: p.string("Which balance.", { enum: ["savings", "current"] }).optional(),
    limit: p.integer().optional(),
  },
  handler: ({ account }) => ({ account, balance: 250 }),
});

function support(): Agent {
  return {
    id: "support",
    instructions: "You are a support agent.",
    greeting: "Hello",
    language: Language.Hindi,
    voice: Voice.Kore,
    pipeline: new Realtime({ model: RealtimeModel.GeminiLive25FlashNativeAudio }),
    tools: [checkBalance],
    opening: Opening.Caller,
    maxDurationMs: 10 * 60_000,
    temperature: 0.3,
    cloud: new CloudAccount({ project: "proj", region: "us-central1", credentialsJson: "{}" }),
    options: {
      interruptible: false,
      firstWordsTimeoutMs: 4000,
      voicemailDetection: true,
      contextCompression: true,
      classifier: ClassifierBackend.GeminiLive,
    },
  };
}

/** Joins a with a fake server and returns the request the server got. */
async function joined(t: Parameters<typeof start>[0], a: Agent): Promise<JoinRoomRequest> {
  const { f, c } = await start(t);
  await c.join(room, a);
  return f.joins[0]!;
}

test("join sends the agent", opts, async (t) => {
  const { f, c } = await start(t);
  const seat = await c.join(room, support(), { participantId: "agent-p", fields: { call_id: "c-9" } });
  assert.deepEqual(
    {
      room: seat.room,
      agentId: seat.agentId,
      participantId: seat.participantId,
      connectionId: seat.connectionId,
      node: seat.node,
    },
    { room: "room-1", agentId: "support", participantId: "p-1", connectionId: "c-1", node: "node:443" },
  );
  assert.equal(f.joins.length, 1);
  assert.deepEqual(f.keys, ["join=k"]);

  const req = f.joins[0]!;
  assert.equal(req.agentId, "support");
  assert.equal(req.roomId, "room-1");
  assert.equal(req.roomUrl, "https://cp.test");
  assert.equal(req.roomToken, "tok");
  assert.equal(req.participantId, "agent-p");
  assert.equal(req.customFieldsJson, '{"call_id":"c-9"}');
  // Who speaks first goes on the request and on the profile.
  assert.equal(req.opening, OpeningTurn.CALLER);

  const pr = req.profile!;
  assert.equal(pr.aiBackend, "gemini-live");
  assert.equal(pr.model, "gemini-live-2.5-flash-native-audio");
  assert.equal(pr.voice, "Kore");
  assert.equal(pr.language, "hi-IN");
  assert.equal(pr.prompt, "You are a support agent.");
  assert.equal(pr.greeting, "Hello");
  assert.equal(pr.providerProject, "proj");
  assert.equal(pr.providerRegion, "us-central1");
  assert.equal(pr.providerCredentials, "{}");
  assert.equal(pr.aiClassifyBackend, "gemini-live");
  assert.equal(pr.maxCallDurationSeconds, 600);
  assert.equal(pr.initialEngagementDeadlineMs, 4000);
  assert.equal(pr.allowInterruptions, false);
  assert.equal(pr.amdEnabled, true);
  assert.equal(pr.contextCompression, true);
  assert.equal(pr.temperature, f32(0.3));
  assert.equal(pr.opening, OpeningTurn.CALLER);
  // Unset switches stay unset, so the server keeps its defaults.
  for (const field of [
    "backchannelGate",
    "endCallEnabled",
    "greetingInterruptible",
    "silenceMonitor",
    "lostUtteranceReplay",
    "minimalAudioProcessing",
    "cascade",
    "speechService",
  ] as const) {
    assert.equal(pr[field], undefined, `${field} was sent`);
  }

  assert.equal(pr.tools.length, 1);
  const spec = pr.tools[0]!;
  assert.equal(spec.name, "check_balance");
  assert.equal(spec.description, "Look up a balance.");
  assert.equal(spec.parameters.account!.type, "string");
  assert.equal(spec.parameters.account!.description, "The account number.");
  assert.deepEqual(spec.parameters.kind!.enum, ["savings", "current"]);
  assert.equal(spec.parameters.limit!.type, "integer");
  assert.deepEqual(spec.required, ["account"], "only account is required (kind and limit are optional)");
});

test("join maps every agent field and option", opts, async (t) => {
  const req = await joined(t, {
    id: "a1",
    instructions: "Be brief.",
    greeting: "Hi",
    closing: "Bye",
    persona: "Warm.",
    language: Language.Tamil,
    voice: Voice.Puck,
    opening: Opening.Agent,
    maxDurationMs: 61_999,
    temperature: 1.5,
    cloud: new CloudAccount({ project: "p", credentialsJson: '{"type":"service_account"}' }),
    options: {
      interruptible: true,
      greetingInterruptible: false,
      firstWordsTimeoutMs: 2500.7,
      backchannelGate: false,
      silenceMonitor: true,
      endCallTool: false,
      voicemailDetection: false,
      replayLostUtterances: true,
      backgroundNoise: true,
      liveTranscription: true,
      contextCompression: false,
      minimalAudioProcessing: true,
      classifier: ClassifierBackend.GeminiLive,
      workspaceId: "ws-1",
    },
  });
  assert.equal(req.opening, OpeningTurn.AGENT);
  assert.equal(req.participantId, "");
  assert.equal(req.customFieldsJson, "");
  const pr = req.profile!;
  assert.deepEqual(
    {
      prompt: pr.prompt,
      greeting: pr.greeting,
      closing: pr.closing,
      personaText: pr.personaText,
      language: pr.language,
      voice: pr.voice,
      opening: pr.opening,
      maxCallDurationSeconds: pr.maxCallDurationSeconds,
      temperature: pr.temperature,
      providerProject: pr.providerProject,
      providerRegion: pr.providerRegion,
      providerCredentials: pr.providerCredentials,
      allowInterruptions: pr.allowInterruptions,
      greetingInterruptible: pr.greetingInterruptible,
      initialEngagementDeadlineMs: pr.initialEngagementDeadlineMs,
      backchannelGate: pr.backchannelGate,
      silenceMonitor: pr.silenceMonitor,
      endCallEnabled: pr.endCallEnabled,
      amdEnabled: pr.amdEnabled,
      lostUtteranceReplay: pr.lostUtteranceReplay,
      backgroundNoise: pr.backgroundNoise,
      liveTranscription: pr.liveTranscription,
      contextCompression: pr.contextCompression,
      minimalAudioProcessing: pr.minimalAudioProcessing,
      aiClassifyBackend: pr.aiClassifyBackend,
      workspaceId: pr.workspaceId,
      aiBackend: pr.aiBackend,
      model: pr.model,
      tools: pr.tools.length,
    },
    {
      prompt: "Be brief.",
      greeting: "Hi",
      closing: "Bye",
      personaText: "Warm.",
      language: "ta-IN",
      voice: "Puck",
      opening: OpeningTurn.AGENT,
      maxCallDurationSeconds: 61,
      temperature: 1.5,
      providerProject: "p",
      providerRegion: "",
      providerCredentials: '{"type":"service_account"}',
      allowInterruptions: true,
      greetingInterruptible: false,
      initialEngagementDeadlineMs: 2500,
      backchannelGate: false,
      silenceMonitor: true,
      endCallEnabled: false,
      amdEnabled: false,
      lostUtteranceReplay: true,
      backgroundNoise: true,
      liveTranscription: true,
      contextCompression: false,
      minimalAudioProcessing: true,
      aiClassifyBackend: "gemini-live",
      workspaceId: "ws-1",
      // No pipeline: the server's default, so neither is set.
      aiBackend: "",
      model: "",
      tools: 0,
    },
  );
});

test("an agent left at its defaults sends nothing it did not set", opts, async (t) => {
  const req = await joined(t, {
    id: "a",
    instructions: "Be brief.",
    cloud: new CloudAccount({ project: "p", credentialsJson: "{}" }),
  });
  const pr = req.profile!;
  assert.equal(req.opening, OpeningTurn.UNSPECIFIED);
  assert.equal(pr.opening, OpeningTurn.UNSPECIFIED);
  assert.equal(pr.temperature, undefined);
  assert.equal(pr.allowInterruptions, undefined);
  assert.equal(pr.maxCallDurationSeconds, 0);
  assert.equal(pr.initialEngagementDeadlineMs, 0);
  assert.equal(pr.backgroundNoise, false);
  assert.equal(pr.aiBackend, "");
});

test("a Realtime pipeline without a model runs the default model", opts, async (t) => {
  const req = await joined(t, { ...support(), pipeline: new Realtime() });
  assert.equal(req.profile!.aiBackend, "gemini-live");
  assert.equal(req.profile!.model, RealtimeModel.GeminiLive25FlashNativeAudio);
});

test("a Cascade fills in the STT region, and leaves zero values unset", opts, async (t) => {
  const req = await joined(t, {
    ...support(),
    pipeline: new Cascade({
      mode: CascadeMode.Audio,
      llm: LLMModel.Gemini25Flash,
      llmRegion: "us-central1",
      llmThinking: true,
      stt: STTModel.Chirp2,
      vad: VAD.Ten,
      vadConfidence: 0.6,
      vadMinVolume: 0,
      sttLanguages: [Language.Hindi, Language.EnglishIndia],
      keywords: ["policy"],
      ttsVoice: Voice.Puck,
      ttsRegion: "global",
      ttsSampleRate: 16000,
      endpointSilenceMs: 500,
      minUtteranceMs: 0.4,
      maxUtteranceMs: 0,
      turnModel: true,
      turnModelMaxSilenceMs: 1200,
      maxHistoryTurns: 8,
    }),
  });
  const pr = req.profile!;
  assert.equal(pr.aiBackend, "google-cascade");
  assert.equal(pr.model, "");
  const c = pr.cascade!;
  assert.equal(c.mode, "audio");
  assert.equal(c.llmModel, "gemini-2.5-flash");
  assert.equal(c.llmRegion, "us-central1");
  assert.equal(c.llmThinking, true);
  assert.equal(c.sttModel, "chirp_2");
  assert.equal(c.sttRegion, "asia-southeast1");
  assert.equal(c.vad, "ten");
  assert.equal(c.vadConfidence, f32(0.6));
  assert.equal(c.vadMinVolume, 0, "an explicit zero threshold is sent");
  assert.deepEqual(c.sttLanguages, ["hi-IN", "en-IN"]);
  assert.deepEqual(c.sttKeywords, ["policy"]);
  assert.equal(c.ttsVoice, "Puck");
  assert.equal(c.ttsRegion, "global");
  assert.equal(c.ttsRate, 16000);
  assert.equal(c.endpointSilenceMs, 500);
  assert.equal(c.minUtteranceMs, 1, "a sub-millisecond duration rounds up to 1ms, not to unset");
  assert.equal(c.turnModel, true);
  assert.equal(c.turnModelMaxSilenceMs, 1200);
  assert.equal(c.maxHistoryTurns, 8);
  // Durations left at zero or undefined stay unset.
  assert.equal(c.maxUtteranceMs, undefined);
  assert.equal(c.transcriptWaitMs, undefined);
  assert.equal(c.prefixPadMs, undefined);
  assert.equal(c.llmTemperature, undefined);
  assert.equal(pr.speechService, undefined);
});

test("each STT model gets the region it is served from, and an explicit region wins", opts, async (t) => {
  const { f, c } = await start(t);
  for (const [stt, region, want] of [
    [STTModel.Short, undefined, "global"],
    [STTModel.Chirp2, undefined, "asia-southeast1"],
    [STTModel.Chirp3, undefined, "eu"],
    [STTModel.Chirp3, "us", "us"],
    [undefined, undefined, ""],
  ] as const) {
    await c.join(room, { ...support(), pipeline: new Cascade({ stt, sttRegion: region }) });
    assert.equal(f.joins.at(-1)!.profile!.cascade!.sttRegion, want, `${stt} in ${region}`);
  }
});

test("a Cascade carries its own temperature and language", opts, async (t) => {
  const req = await joined(t, {
    ...support(),
    pipeline: new Cascade({ llmTemperature: 0.4, ttsLanguage: Language.Tamil }),
  });
  assert.equal(req.profile!.cascade!.llmTemperature, f32(0.4));
  assert.equal(req.profile!.cascade!.ttsLanguage, "ta-IN");
});

test("a UlaiLive pipeline sends its speech service", opts, async (t) => {
  const req = await joined(t, {
    ...support(),
    pipeline: new UlaiLive({ url: "live.example.com", insecure: true, voice: UlaiLiveVoice.Alba, outputRate: 16000 }),
  });
  const pr = req.profile!;
  assert.equal(pr.aiBackend, "ulai-live");
  assert.equal(pr.model, "");
  assert.deepEqual(
    {
      url: pr.speechService!.url,
      insecure: pr.speechService!.insecure,
      voice: pr.speechService!.voice,
      outputRate: pr.speechService!.outputRate,
    },
    { url: "live.example.com", insecure: true, voice: "alba", outputRate: 16000 },
  );
  assert.equal(pr.cascade, undefined);
});

test("validate rejects what the server would", () => {
  const nested = { address: { type: "object" } } as never;
  const cases: [string, (a: Agent) => void, RegExp][] = [
    ["no id", (a) => (a.id = ""), /Agent\.id is required/],
    ["no instructions", (a) => (a.instructions = ""), /Agent\.instructions is required/],
    ["no cloud", (a) => (a.cloud = undefined), /Agent\.cloud needs a project and credentialsJson/],
    [
      "cloud without key",
      (a) => (a.cloud = new CloudAccount({ project: "p", credentialsJson: "" })),
      /Agent\.cloud needs/,
    ],
    [
      "cloud without project",
      (a) => (a.cloud = new CloudAccount({ project: "", credentialsJson: "{}" })),
      /Agent\.cloud needs/,
    ],
    ["cascade needs cloud", (a) => ((a.cloud = undefined), (a.pipeline = new Cascade())), /Agent\.cloud needs/],
    ["default pipeline needs cloud", (a) => ((a.cloud = undefined), (a.pipeline = undefined)), /Agent\.cloud needs/],
    [
      "ulai-live voicemail needs cloud",
      (a) => {
        a.cloud = undefined;
        a.pipeline = new UlaiLive();
        a.options = { voicemailDetection: true };
      },
      /Agent\.cloud needs/,
    ],
    ["sub-second duration", (a) => (a.maxDurationMs = 500), /zero \(the server's limit\) or at least 1000/],
    ["negative duration", (a) => (a.maxDurationMs = -1), /at least 1000/],
    ["voice typo", (a) => (a.voice = "Pukc" as Voice), /unknown voice "Pukc"/],
    ["language", (a) => (a.language = "xx-XX" as Language), /unknown language "xx-XX"/],
    [
      "realtime model",
      (a) => (a.pipeline = new Realtime({ model: "gpt-x" as RealtimeModel })),
      /unknown RealtimeModel "gpt-x"/,
    ],
    ["llm", (a) => (a.pipeline = new Cascade({ llm: "gpt-x" as LLMModel })), /unknown llm "gpt-x"/],
    ["stt", (a) => (a.pipeline = new Cascade({ stt: "long" as STTModel })), /unknown stt "long"/],
    ["vad", (a) => (a.pipeline = new Cascade({ vad: "webrtc" as VAD })), /unknown vad "webrtc"/],
    ["mode", (a) => (a.pipeline = new Cascade({ mode: "x" as CascadeMode })), /unknown mode "x"/],
    [
      "stt language",
      (a) => (a.pipeline = new Cascade({ sttLanguages: ["xx" as Language] })),
      /unknown sttLanguages entry "xx"/,
    ],
    ["tts voice", (a) => (a.pipeline = new Cascade({ ttsVoice: "bob" as Voice })), /unknown ttsVoice "bob"/],
    ["tts language", (a) => (a.pipeline = new Cascade({ ttsLanguage: "xx" as Language })), /unknown ttsLanguage "xx"/],
    [
      "ulai voice",
      (a) => (a.pipeline = new UlaiLive({ voice: "bob" as UlaiLiveVoice })),
      /UlaiLive: unknown voice "bob"/,
    ],
    ["temperature", (a) => (a.temperature = 3), /temperature 3 is outside 0 to 2/],
    ["negative temperature", (a) => (a.temperature = -0.1), /outside 0 to 2/],
    ["NaN temperature", (a) => (a.temperature = NaN), /outside 0 to 2/],
    [
      "llm temperature",
      (a) => (a.pipeline = new Cascade({ llmTemperature: 2.5 })),
      /Cascade: llmTemperature 2\.5 is outside 0 to 2/,
    ],
    [
      "vad confidence",
      (a) => (a.pipeline = new Cascade({ vadConfidence: 1.5 })),
      /vadConfidence 1\.5 is outside 0 to 1/,
    ],
    ["vad volume", (a) => (a.pipeline = new Cascade({ vadMinVolume: -1 })), /vadMinVolume -1 is outside 0 to 1/],
    [
      "negative sample rate",
      (a) => (a.pipeline = new Cascade({ ttsSampleRate: -1 })),
      /ttsSampleRate -1 cannot be negative/,
    ],
    [
      "fractional history",
      (a) => (a.pipeline = new Cascade({ maxHistoryTurns: 1.5 })),
      /maxHistoryTurns 1\.5 must be a whole number/,
    ],
    [
      "negative cascade duration",
      (a) => (a.pipeline = new Cascade({ prefixPadMs: -5 })),
      /prefixPadMs -5 cannot be negative/,
    ],
    [
      "negative output rate",
      (a) => (a.pipeline = new UlaiLive({ outputRate: -1 })),
      /UlaiLive: outputRate -1 cannot be negative/,
    ],
    [
      "negative first words",
      (a) => (a.options = { firstWordsTimeoutMs: -1 }),
      /firstWordsTimeoutMs -1 cannot be negative/,
    ],
    ["opening", (a) => (a.opening = "whoever" as Opening), /unknown opening "whoever"/],
    [
      "not a pipeline",
      (a) => (a.pipeline = { model: "x" } as never),
      /Agent\.pipeline must be a Realtime, Cascade or UlaiLive/,
    ],
    [
      "tool name",
      (a) => (a.tools = [tool({ name: "check balance", description: "d" })]),
      /tool name "check balance" must start with a letter/,
    ],
    [
      "tool name too long",
      (a) => (a.tools = [tool({ name: "a".repeat(65), description: "d" })]),
      /at most 64 characters/,
    ],
    ["tool name start", (a) => (a.tools = [tool({ name: "1tool", description: "d" })]), /tool name "1tool"/],
    ["tool description", (a) => (a.tools = [tool({ name: "t", description: " " })]), /tool "t" needs a description/],
    [
      "tool arg type",
      (a) => (a.tools = [tool({ name: "t", description: "d", parameters: nested })]),
      /parameter address has type "object"; use p\.string/,
    ],
    [
      "schema arg type",
      (a) => (a.tools = [toolFromSchema("t", "d", { x: { type: "array" as never } })]),
      /parameter x has type "array"/,
    ],
    [
      "schema required",
      (a) => (a.tools = [toolFromSchema("t", "d", { x: { type: "string" } }, ["y"])]),
      /required parameter y is not among its parameters/,
    ],
    ["tool twice", (a) => (a.tools = [checkBalance, checkBalance]), /tool "check_balance" is declared twice/],
    [
      "not a tool",
      (a) => (a.tools = [{ name: "x", description: "d" } as never]),
      /Agent\.tools\[0\] is not a tool: build it with tool\(\)/,
    ],
    ["classifier", (a) => (a.options = { classifier: "x" as ClassifierBackend }), /unknown options\.classifier "x"/],
  ];
  for (const [name, edit, want] of cases) {
    const a = support();
    edit(a);
    assert.throws(
      () => validate(a),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, `${name}: ${String(err)}`);
        assert.ok(err instanceof AgentError);
        assert.match(err.message, want, name);
        return true;
      },
      name,
    );
  }
});

test("validate lists every problem, not just the first", () => {
  assert.throws(
    () => validate({ id: "", instructions: "", voice: "Pukc" as Voice, temperature: 9 }),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.problems.length, 5, err.message);
      assert.match(err.problems[0]!, /Agent\.id is required/);
      assert.match(err.message, /Agent\.instructions[\s\S]*Agent\.cloud[\s\S]*voice[\s\S]*temperature/);
      return true;
    },
  );
});

test("validate accepts the smallest valid agents, and the boundaries", () => {
  const cloud = new CloudAccount({ project: "p", credentialsJson: "{}" });
  validate({ id: "a", instructions: "Be brief.", cloud, tools: [tool({ name: "ping", description: "Ping." })] });
  // A UlaiLive call without voicemail detection reaches no Google model.
  validate({ id: "a", instructions: "Be brief.", pipeline: new UlaiLive() });
  validate({ id: "a", instructions: "Be brief.", pipeline: new UlaiLive(), options: { voicemailDetection: false } });
  for (const maxDurationMs of [0, 1000, 3_600_000]) {
    validate({ id: "a", instructions: "x", cloud, maxDurationMs });
  }
  for (const temperature of [0, 2]) {
    validate({ id: "a", instructions: "x", cloud, temperature });
  }
  validate({
    id: "a",
    instructions: "x",
    cloud,
    pipeline: new Cascade({ vadConfidence: 0, vadMinVolume: 1, llmTemperature: 0 }),
  });
  // Tool names may use letters, digits, _ . - after a letter or underscore, up to 64 characters.
  validate({
    id: "a",
    instructions: "x",
    cloud,
    tools: [tool({ name: "_a.b-c_9" + "x".repeat(56), description: "d" })],
  });
});

test("join refuses an invalid agent or room before it reaches the server", opts, async (t) => {
  const { f, c } = await start(t);
  await assert.rejects(c.join(room, { ...support(), voice: "Pukc" as Voice }), ValidationError);
  await assert.rejects(c.join({ id: "", url: "" }, support()), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.deepEqual(err.problems, [
      "join needs room.id: the server never creates rooms",
      "join needs room.url, the control plane holding the room",
    ]);
    return true;
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(c.join(room, support(), { fields: circular }), /fields could not be encoded/);
  assert.equal(f.joins.length, 0, "an invalid agent reached the server");
});

test("allowUnlistedValues sends stored values, but still checks ranges and structure", opts, async (t) => {
  const { f, c } = await start(t);
  const stored: Agent = {
    ...support(),
    voice: "SomeNewVoice" as Voice,
    language: "hi-IN,en-IN" as Language,
    pipeline: new Realtime({ model: "gemini-live-next" as RealtimeModel }),
    options: { classifier: "new-classifier" as ClassifierBackend },
  };
  await assert.rejects(c.join(room, stored), ValidationError);
  await c.join(room, stored, { allowUnlistedValues: true });
  const pr = f.joins[0]!.profile!;
  assert.equal(pr.voice, "SomeNewVoice");
  assert.equal(pr.language, "hi-IN,en-IN");
  assert.equal(pr.model, "gemini-live-next");
  assert.equal(pr.aiBackend, "gemini-live", "an unlisted realtime model runs on the realtime backend");
  assert.equal(pr.aiClassifyBackend, "new-classifier");

  // Values no server could take are still refused.
  for (const bad of [
    { ...stored, temperature: 9 },
    { ...stored, maxDurationMs: 10 },
    { ...stored, opening: "whoever" as Opening },
    { ...stored, cloud: undefined },
    { ...stored, pipeline: new Cascade({ llm: "x" as LLMModel, vadConfidence: 2 }) },
  ]) {
    await assert.rejects(c.join(room, bad, { allowUnlistedValues: true }), ValidationError);
  }
  assert.equal(f.joins.length, 1);
  // validate takes the same option.
  validate({ ...stored, voice: "Another" as Voice }, { allowUnlistedValues: true });
});

test("secrets stay out of logs", () => {
  const cloud = new CloudAccount({ project: "p", region: "r", credentialsJson: '{"private_key":"SECRET"}' });
  const r = new Room({ id: "r1", url: "https://cp", token: "SECRET" });
  const agent: Agent = { id: "a", instructions: "x", cloud };
  const outputs = [
    String(cloud),
    `${cloud}`,
    JSON.stringify(cloud),
    inspect(cloud),
    inspect(cloud, { showHidden: true, depth: 9 }),
    format("%o", cloud),
    format("%j", cloud),
    JSON.stringify({ ...cloud }),
    String(r),
    JSON.stringify(r),
    inspect(r),
    inspect(r, { showHidden: true }),
    format("%o", r),
    JSON.stringify({ ...r }),
    JSON.stringify(agent),
    inspect(agent, { depth: 9 }),
  ];
  for (const s of outputs) {
    assert.ok(!s.includes("SECRET"), `a secret was printed: ${s}`);
  }
  assert.match(String(r), /r1/);
  assert.match(String(r), /\[redacted\]/);
  assert.match(inspect(cloud), /project: 'p'/);
  // The values are still there for the SDK to send.
  assert.equal(cloud.credentialsJson, '{"private_key":"SECRET"}');
  assert.equal(r.token, "SECRET");
  // An empty secret is shown as empty, not as redacted.
  assert.match(String(new Room({ id: "r", url: "u" })), /token:\}/);
});

test("a Room's token reaches the server", opts, async (t) => {
  const { f, c } = await start(t);
  await c.join(new Room(room), support());
  assert.equal(f.joins[0]!.roomToken, "tok");
});

test("CloudAccount.fromFile reads a service-account key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ulai-agents-"));
  const good = join(dir, "key.json");
  await writeFile(good, '{"type":"service_account","project_id":"p"}');
  const c = await CloudAccount.fromFile("p", "us-central1", good);
  assert.equal(c.project, "p");
  assert.equal(c.region, "us-central1");
  assert.match(c.credentialsJson, /service_account/);

  const bad = join(dir, "bad.json");
  await writeFile(bad, "not json");
  await assert.rejects(CloudAccount.fromFile("p", "", bad), /is not a service-account key file/);
  const untyped = join(dir, "untyped.json");
  await writeFile(untyped, '{"project_id":"p"}');
  await assert.rejects(CloudAccount.fromFile("p", "", untyped), /is not a service-account key file/);
  await assert.rejects(CloudAccount.fromFile("p", "", join(dir, "missing.json")), (err: unknown) => {
    assert.ok(err instanceof AgentError);
    assert.match(err.message, /reading the service-account key/);
    return true;
  });
});

test("the constants carry the values the server knows", () => {
  assert.deepEqual(Object.values(RealtimeModel), ["gemini-live-2.5-flash-native-audio"]);
  assert.deepEqual(Object.values(LLMModel), ["gemini-2.5-flash"]);
  assert.deepEqual(STTModel, { Short: "short", Chirp2: "chirp_2", Chirp3: "chirp_3" });
  assert.deepEqual(CascadeMode, { STT: "stt", Audio: "audio" });
  assert.deepEqual(VAD, { Silero: "silero", Ten: "ten" });
  assert.deepEqual(UlaiLiveVoice, { Alba: "alba" });
  assert.deepEqual(ClassifierBackend, { GeminiLive: "gemini-live" });
  assert.deepEqual(Opening, { Agent: "agent", Caller: "caller" });
  assert.deepEqual(Language, {
    EnglishIndia: "en-IN",
    EnglishUS: "en-US",
    EnglishUK: "en-GB",
    Hindi: "hi-IN",
    Bengali: "bn-IN",
    Gujarati: "gu-IN",
    Kannada: "kn-IN",
    Malayalam: "ml-IN",
    Marathi: "mr-IN",
    Tamil: "ta-IN",
    Telugu: "te-IN",
  });
  const voices = [
    "Achernar",
    "Achird",
    "Algenib",
    "Algieba",
    "Alnilam",
    "Aoede",
    "Autonoe",
    "Callirrhoe",
    "Charon",
    "Despina",
    "Enceladus",
    "Erinome",
    "Fenrir",
    "Gacrux",
    "Iapetus",
    "Kore",
    "Laomedeia",
    "Leda",
    "Orus",
    "Puck",
    "Pulcherrima",
    "Rasalgethi",
    "Sadachbia",
    "Sadaltager",
    "Schedar",
    "Sulafat",
    "Umbriel",
    "Vindemiatrix",
    "Zephyr",
    "Zubenelgenubi",
  ];
  assert.deepEqual(Voice, Object.fromEntries(voices.map((v) => [v, v])));
});

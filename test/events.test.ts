// Every server event arrives as the event a handler switches on, with its
// fields intact. A field mapped to the wrong one reads as a plausible number,
// so each is checked by value.

import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import {
  AgentState as PBAgentState,
  Pipeline as PBPipeline,
  ServerEventSchema,
  Speaker as PBSpeaker,
  TurnDetection as PBTurnDetection,
} from "ulai-agent-protocol/ulai/agent/v1";

import { eventFrom } from "../dist/events.js";
import { AgentState, PipelineKind, Speaker, TurnDetection, type Event } from "../dist/index.js";
import { start, type ServerEventInit } from "./fake-server.js";

const cases: [string, ServerEventInit, Event][] = [
  [
    "transcript",
    { elapsedMs: 1200n, event: { case: "transcript", value: { speaker: PBSpeaker.AGENT, text: "hi", final: true } } },
    { type: "transcript", elapsedMs: 1200, speaker: "agent", text: "hi", final: true },
  ],
  [
    "turn started",
    { elapsedMs: 5n, event: { case: "turnStarted", value: { speaker: PBSpeaker.CALLER, turnId: "t1" } } },
    { type: "turnStarted", elapsedMs: 5, speaker: "caller", turnId: "t1" },
  ],
  [
    "turn ended",
    {
      elapsedMs: 9000n,
      event: {
        case: "turnEnded",
        value: {
          speaker: PBSpeaker.AGENT,
          turnId: "t2",
          durationMs: 1500,
          transcript: "Let me",
          interrupted: true,
          heardMs: 800,
          generated: "Let me check",
          audioBytes: 9600n,
          ttsCharacters: 12n,
          toolCalls: [{ id: "c1", name: "check_balance", argsJson: '{"a":1}' }],
          tokens: {
            promptTotal: 100n,
            promptCached: 40n,
            responseTotal: 20n,
            total: 130n,
            reasoning: 7n,
            toolPrompt: 3n,
            prompt: [
              { modality: "audio", tokens: 60n },
              { modality: "text", tokens: 40n },
            ],
            response: [{ modality: "text", tokens: 20n }],
          },
        },
      },
    },
    {
      type: "turnEnded",
      elapsedMs: 9000,
      speaker: "agent",
      turnId: "t2",
      text: "Let me",
      durationMs: 1500,
      interrupted: true,
      heardMs: 800,
      generated: "Let me check",
      audioBytes: 9600,
      ttsChars: 12,
      toolCalls: [
        { type: "toolCall", elapsedMs: 9000, id: "c1", name: "check_balance", args: { a: 1 }, argsJson: '{"a":1}' },
      ],
      tokens: {
        promptTotal: 100,
        promptCached: 40,
        prompt: { audio: 60, text: 40 },
        responseTotal: 20,
        response: { text: 20 },
        total: 130,
        reasoning: 7,
        toolPrompt: 3,
      },
    },
  ],
  [
    "turn ended without heard or tokens",
    { event: { case: "turnEnded", value: { speaker: PBSpeaker.CALLER, turnId: "t3", transcript: "yes" } } },
    {
      type: "turnEnded",
      elapsedMs: 0,
      speaker: "caller",
      turnId: "t3",
      text: "yes",
      durationMs: 0,
      interrupted: false,
      heardMs: 0,
      generated: "",
      audioBytes: 0,
      ttsChars: 0,
      toolCalls: [],
      tokens: undefined,
    },
  ],
  [
    "state",
    { elapsedMs: 7n, event: { case: "agentState", value: { state: PBAgentState.THINKING } } },
    { type: "stateChanged", elapsedMs: 7, state: "thinking" },
  ],
  [
    "tool call",
    { elapsedMs: 8n, event: { case: "toolCall", value: { id: "c9", name: "lookup", argsJson: '{"order":"o-1"}' } } },
    { type: "toolCall", elapsedMs: 8, id: "c9", name: "lookup", args: { order: "o-1" }, argsJson: '{"order":"o-1"}' },
  ],
  [
    "tool outcome",
    {
      elapsedMs: 10n,
      event: {
        case: "toolOutcome",
        value: { id: "o1", name: "end_call", argsJson: "{}", resultJson: '{"ok":true}', error: "e", errorCode: "X" },
      },
    },
    {
      type: "toolOutcome",
      elapsedMs: 10,
      id: "o1",
      name: "end_call",
      args: {},
      argsJson: "{}",
      result: { ok: true },
      resultJson: '{"ok":true}',
      error: "e",
      errorCode: "X",
    },
  ],
  [
    "usage",
    {
      elapsedMs: 11n,
      event: {
        case: "usage",
        value: {
          promptTotal: 500n,
          promptCached: 100n,
          responseTotal: 50n,
          prompt: [{ modality: "text", tokens: 500n }],
          response: [{ modality: "audio", tokens: 50n }],
          models: [
            {
              role: "realtime",
              provider: "p",
              model: "m",
              unit: "tokens",
              audio: { input: 1n, cached: 2n, output: 3n },
              text: { input: 4n },
            },
            { role: "amd", provider: "q", model: "n", unit: "seconds" },
          ],
        },
      },
    },
    {
      type: "usage",
      elapsedMs: 11,
      promptTotal: 500,
      promptCached: 100,
      responseTotal: 50,
      prompt: { text: 500 },
      response: { audio: 50 },
      models: [
        {
          role: "realtime",
          provider: "p",
          model: "m",
          unit: "tokens",
          audio: { input: 1, cached: 2, output: 3 },
          text: { input: 4, cached: 0, output: 0 },
        },
        {
          role: "amd",
          provider: "q",
          model: "n",
          unit: "seconds",
          audio: { input: 0, cached: 0, output: 0 },
          text: { input: 0, cached: 0, output: 0 },
        },
      ],
    },
  ],
  [
    "rejected",
    { elapsedMs: 12n, event: { case: "error", value: { sequenceRef: 3n, message: "no" } } },
    { type: "rejected", elapsedMs: 12, command: "", message: "no" },
  ],
  [
    "ended",
    {
      elapsedMs: 60000n,
      event: {
        case: "sessionEnded",
        value: {
          reason: "agent_ended",
          disposition: "COMPLETED",
          durationMs: 60000n,
          playedMs: 30000n,
          endReason: "max_duration",
          pipelineMetrics: {
            ttfbAvgMs: 700.25,
            ttfbP50Ms: 650,
            ttfbP95Ms: 812.5,
            ttfbP99Ms: 990,
            ttfbMinMs: 400,
            ttfbMaxMs: 1200,
            userTurns: 6,
            agentTurns: 7,
            interruptedTurns: 2,
            userSpeakingMs: 21000.5,
            agentSpeakingMs: 30000,
            inboundFramesTotal: 3000n,
            inboundAvgUs: 120.5,
            inboundMaxUs: 950n,
            outboundChunksTotal: 1500n,
            outboundAvgUs: 80,
            outboundMaxUs: 4000n,
            drops: {
              inputFilter: 1n,
              toModel: 3n,
              fromModel: 4n,
              modelWrite: 5n,
              providerSend: 6n,
              providerReceive: 7n,
              recording: 8n,
            },
          },
        },
      },
    },
    {
      type: "ended",
      elapsedMs: 60000,
      reason: "agent_ended",
      disposition: "COMPLETED",
      durationMs: 60000,
      heardMs: 30000,
      endReason: "max_duration",
      pipeline: {
        ttfbAvgMs: 700.25,
        ttfbP50Ms: 650,
        ttfbP95Ms: 812.5,
        ttfbP99Ms: 990,
        ttfbMinMs: 400,
        ttfbMaxMs: 1200,
        userTurns: 6,
        agentTurns: 7,
        interruptedTurns: 2,
        userSpeakingMs: 21000.5,
        agentSpeakingMs: 30000,
        inboundFrames: 3000,
        inboundAvgMs: 0.1205,
        inboundMaxMs: 0.95,
        outboundChunks: 1500,
        outboundAvgMs: 0.08,
        outboundMaxMs: 4,
        droppedByStage: {
          input_filter: 1,
          to_model: 3,
          from_model: 4,
          model_write: 5,
          provider_send: 6,
          provider_receive: 7,
          recording: 8,
        },
      },
    },
  ],
  [
    "ended without figures",
    { event: { case: "sessionEnded", value: {} } },
    {
      type: "ended",
      elapsedMs: 0,
      reason: "",
      disposition: "",
      durationMs: 0,
      heardMs: 0,
      endReason: "",
      pipeline: undefined,
    },
  ],
  [
    "ended with figures but no drops",
    { event: { case: "sessionEnded", value: { pipelineMetrics: { agentTurns: 1 } } } },
    {
      type: "ended",
      elapsedMs: 0,
      reason: "",
      disposition: "",
      durationMs: 0,
      heardMs: 0,
      endReason: "",
      pipeline: {
        ttfbAvgMs: 0,
        ttfbP50Ms: 0,
        ttfbP95Ms: 0,
        ttfbP99Ms: 0,
        ttfbMinMs: 0,
        ttfbMaxMs: 0,
        userTurns: 0,
        agentTurns: 1,
        interruptedTurns: 0,
        userSpeakingMs: 0,
        agentSpeakingMs: 0,
        inboundFrames: 0,
        inboundAvgMs: 0,
        inboundMaxMs: 0,
        outboundChunks: 0,
        outboundAvgMs: 0,
        outboundMaxMs: 0,
        droppedByStage: undefined,
      },
    },
  ],
];

for (const [name, wire, want] of cases) {
  test(`event: ${name}`, () => {
    assert.deepEqual(eventFrom(create(ServerEventSchema, wire)), want);
  });
}

test("events a client does not see are skipped", () => {
  assert.equal(
    eventFrom(create(ServerEventSchema, { event: { case: "sessionStarted", value: { sessionId: "s" } } })),
    undefined,
  );
  assert.equal(eventFrom(create(ServerEventSchema, {})), undefined);
});

test("unknown speakers and states read as empty, and bad JSON as undefined", () => {
  assert.deepEqual(
    eventFrom(create(ServerEventSchema, { event: { case: "transcript", value: { speaker: PBSpeaker.UNSPECIFIED } } })),
    { type: "transcript", elapsedMs: 0, speaker: "", text: "", final: false },
  );
  assert.deepEqual(eventFrom(create(ServerEventSchema, { event: { case: "agentState", value: {} } })), {
    type: "stateChanged",
    elapsedMs: 0,
    state: "",
  });
  const call = eventFrom(create(ServerEventSchema, { event: { case: "toolCall", value: { argsJson: "{nope" } } }));
  assert.equal(call?.type === "toolCall" && call.args, undefined);
  assert.equal(call?.type === "toolCall" && call.argsJson, "{nope");
});

test("the speaker, state, pipeline and turn-detection constants", () => {
  assert.deepEqual(Speaker, { Caller: "caller", Agent: "agent" });
  assert.deepEqual(AgentState, { Listening: "listening", Thinking: "thinking", Speaking: "speaking" });
  assert.deepEqual(PipelineKind, { Realtime: "realtime", SemiCascade: "semi-cascade", Cascade: "cascade" });
  assert.deepEqual(TurnDetection, { Server: "server", Client: "client" });
});

test(
  "every kind arrives over the wire, in order, and the session describes the call",
  { timeout: 15_000 },
  async (t) => {
    const { c } = await start(t, (f) => {
      f.session = async (stream) => {
        await stream.recv();
        stream.send({
          sequence: 1n,
          event: {
            case: "sessionStarted",
            value: {
              sessionId: "room-1",
              call: {
                callId: "c-9",
                agentId: "support",
                direction: "room",
                fromNumber: "p-1",
                toNumber: "room-1",
                customFieldsJson: '{"call_id":"c-9","n":2}',
              },
              backend: {
                provider: "google",
                model: "m",
                pipeline: PBPipeline.SEMI_CASCADE,
                turnDetection: PBTurnDetection.CLIENT,
              },
            },
          },
        });
        for (const [, wire] of cases.filter(([n]) => !n.startsWith("ended"))) {
          stream.send(wire);
        }
        stream.send(cases.find(([n]) => n === "ended")![1]);
      };
    });
    const s = await c.attach("room-1");
    assert.deepEqual(s.call, {
      callId: "c-9",
      agentId: "support",
      direction: "room",
      from: "p-1",
      to: "room-1",
      fields: { call_id: "c-9", n: 2 },
    });
    assert.deepEqual(s.backend, { provider: "google", model: "m", pipeline: "semi-cascade", turnDetection: "client" });
    const got: Event[] = [];
    for await (const ev of s.events()) {
      got.push(ev);
    }
    const want = cases.filter(([n]) => !n.startsWith("ended")).map(([, , ev]) => ev);
    want.push(cases.find(([n]) => n === "ended")![2]);
    // The tool call is not answered (no tool claimed), only delivered.
    assert.deepEqual(got, want);
  },
);

test("a call with no custom fields or backend reads as empty", { timeout: 15_000 }, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await stream.recv();
      stream.send({
        event: { case: "sessionStarted", value: { sessionId: "s", call: { customFieldsJson: "[1,2]" } } },
      });
      stream.send({ event: { case: "sessionEnded", value: {} } });
    };
  });
  const s = await c.attach("s");
  assert.deepEqual(s.call.fields, {});
  assert.deepEqual(s.backend, { provider: "", model: "", pipeline: "", turnDetection: "" });
  await s.close();
});

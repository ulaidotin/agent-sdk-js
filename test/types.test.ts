// The API as a user writes it. Most of this file is checked by the compiler:
// it does not build if the types drift from what the README promises.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  Client,
  CloudAccount,
  Language,
  Realtime,
  RealtimeModel,
  Speaker,
  Voice,
  p,
  tool,
  toolFromSchema,
  type Agent,
  type Event,
  type Session,
  type ToolArgs,
} from "../dist/index.js";
import { acceptAttach, FakeServer } from "./fake-server.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(): void {}

test("the README's usage compiles and runs", { timeout: 15_000 }, async (t) => {
  const f = new FakeServer();
  await f.listen();
  t.after(() => f.close());
  f.session = async (stream) => {
    await acceptAttach(stream);
    await stream.recv(); // tool claim
    stream.send({
      event: {
        case: "toolCall",
        value: { id: "1", name: "check_balance", argsJson: '{"account":"a1","kind":"savings"}' },
      },
    });
    await stream.recv();
    stream.send({ event: { case: "transcript", value: { speaker: 1, text: "thanks", final: true } } });
    stream.send({ event: { case: "sessionEnded", value: {} } });
  };

  const dir = await mkdtemp(join(tmpdir(), "ulai-agents-"));
  await writeFile(join(dir, "key.json"), '{"type":"service_account"}');
  const project = "proj";
  const region = "us-central1";
  const apiKey = "k";
  const roomId = "room-1";
  const roomUrl = "https://cp.test";
  const token = "tok";

  let seen: { account: string; kind: "savings" | "current" | undefined } | undefined;
  const checkBalance = tool({
    name: "check_balance",
    description: "Look up the balance of an account.",
    parameters: {
      account: p.string("The account number."),
      kind: p.string("Which balance.", { enum: ["savings", "current"] }).optional(),
    },
    handler: async ({ account, kind }) => {
      expectType<Equal<typeof account, string>>();
      expectType<Equal<typeof kind, "savings" | "current" | undefined>>();
      seen = { account, kind };
      return { account, balance: 250 };
    },
  });
  // Not annotated as Agent: a plain object literal is enough.
  const support = {
    id: "support",
    instructions: "...",
    greeting: "...",
    voice: Voice.Kore,
    language: Language.EnglishIndia,
    pipeline: new Realtime({ model: RealtimeModel.GeminiLive25FlashNativeAudio }),
    cloud: await CloudAccount.fromFile(project, region, join(dir, "key.json")),
    tools: [checkBalance],
  };

  const finals: string[] = [];
  const client = new Client(`127.0.0.1:${f.port}`, { apiKey });
  await client.run({ id: roomId, url: roomUrl, token }, support, async (session) => {
    for await (const ev of session.events()) {
      if (ev.type === "transcript" && ev.final) {
        finals.push(ev.text);
      }
    }
  });
  client.close();
  assert.deepEqual(seen, { account: "a1", kind: "savings" });
  assert.deepEqual(finals, ["thanks"]);
});

test("argument types follow the parameters", () => {
  const params = {
    a: p.string(),
    b: p.integer("n", { enum: [1, 2] }),
    c: p.number().optional(),
    d: p.boolean().optional(),
    e: p.string("e", { enum: ["x"] }).optional(),
  };
  expectType<Equal<ToolArgs<typeof params>, { a: string; b: 1 | 2; c?: number; d?: boolean; e?: "x" }>>();

  tool({
    name: "t",
    description: "d",
    parameters: params,
    handler: (args) => {
      // @ts-expect-error: no such parameter
      void args.missing;
      // @ts-expect-error: c may be missing
      const c: number = args.c;
      void c;
    },
  });
  // A tool with no parameters gets an empty object.
  tool({ name: "t", description: "d", handler: (args) => expectType<Equal<typeof args, {}>>() });
  // A run-time schema hands over a plain object.
  toolFromSchema("t", "d", {}, [], (args) => expectType<Equal<typeof args, Record<string, unknown>>>());
});

test("constants are typed, and a typo does not compile", () => {
  // @ts-expect-error: not a voice
  const v: Voice = "Pukc";
  void v;
  expectType<Equal<typeof Voice.Kore, "Kore">>();
  expectType<
    Equal<
      Language,
      "en-IN" | "en-US" | "en-GB" | "hi-IN" | "bn-IN" | "gu-IN" | "kn-IN" | "ml-IN" | "mr-IN" | "ta-IN" | "te-IN"
    >
  >();
  const agent: Agent = { id: "a", instructions: "x", voice: Voice.Puck };
  assert.equal(agent.voice, "Puck");
});

test("events narrow on type, and a session has no say", () => {
  function handle(ev: Event, session: Session): void {
    switch (ev.type) {
      case "turnEnded":
        expectType<Equal<typeof ev.heardMs, number>>();
        break;
      case "rejected":
        expectType<
          Equal<
            typeof ev.command,
            "" | "reply" | "injectContext" | "interrupt" | "hangup" | "toolResult" | "handledTools"
          >
        >();
        break;
      case "transcript":
        if (ev.speaker === Speaker.Caller) {
          void session.reply("x");
        }
        break;
    }
    // @ts-expect-error: the server cannot say a line as written
    void session.say;
    expectType<
      Equal<
        Event["type"],
        | "transcript"
        | "turnStarted"
        | "turnEnded"
        | "stateChanged"
        | "toolCall"
        | "toolOutcome"
        | "usage"
        | "rejected"
        | "ended"
      >
    >();
  }
  void handle;
});

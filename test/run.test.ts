// run: join, attach with the agent's tools, run the handler, always leave.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";

import {
  CallLostError,
  CanceledError,
  CloudAccount,
  NotFoundError,
  Realtime,
  RoomFullError,
  ValidationError,
  Voice,
  p,
  tool,
  type Agent,
  type Ended,
} from "../dist/index.js";
import { acceptAttach, room, sleep, start } from "./fake-server.js";

const opts = { timeout: 15_000 };

function support(): Agent {
  return {
    id: "support",
    instructions: "You are a support agent.",
    voice: Voice.Kore,
    pipeline: new Realtime(),
    cloud: new CloudAccount({ project: "proj", credentialsJson: "{}" }),
    tools: [
      tool({
        name: "check_balance",
        description: "Look up a balance.",
        parameters: { account: p.string("The account number.") },
        handler: ({ account }) => ({ account, balance: 250 }),
      }),
      tool({ name: "declared", description: "Answered elsewhere." }),
    ],
  };
}

test("run joins, attaches with the agent's tools, answers them, runs the handler and leaves", opts, async (t) => {
  let handled: string[] = [];
  let result = "";
  let said = "";
  let replay: boolean | undefined;
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      const attach = await stream.recv();
      if (attach?.event.case !== "attach" || attach.event.value.sessionId !== "room-1") {
        throw new ConnectError("want an attach to room-1", Code.FailedPrecondition);
      }
      replay = attach.event.value.replayHistory;
      stream.send({
        event: {
          case: "sessionStarted",
          value: {
            sessionId: "room-1",
            call: { callId: "c-9", agentId: "support", customFieldsJson: '{"call_id":"c-9"}' },
            backend: { provider: "test", pipeline: 1 },
          },
        },
      });
      const claim = await stream.recv();
      handled = claim?.event.case === "handledTools" ? claim.event.value.names : [];
      stream.send({
        event: { case: "toolCall", value: { id: "t1", name: "check_balance", argsJson: '{"account":"a1"}' } },
      });
      const res = await stream.recv();
      result = res?.event.case === "toolResult" ? res.event.value.resultJson : "";
      stream.send({ event: { case: "transcript", value: { speaker: 1, text: "hello", final: true } } });
      const reply = await stream.recv();
      said = reply?.event.case === "generateReply" ? reply.event.value.instructions : "";
      stream.send({
        elapsedMs: 3000n,
        event: { case: "sessionEnded", value: { reason: "caller_hangup", playedMs: 900n } },
      });
    };
  });

  let ended: Ended | undefined;
  await c.run(
    room,
    support(),
    async (s, signal) => {
      assert.equal(s.call.fields.call_id, "c-9");
      assert.equal(s.call.callId, "c-9");
      assert.equal(s.backend.pipeline, "realtime");
      assert.equal(signal.aborted, false);
      for await (const ev of s.events()) {
        if (ev.type === "transcript") {
          await s.reply(`greet ${ev.text}`);
        } else if (ev.type === "ended") {
          ended = ev;
        }
      }
    },
    { participantId: "agent-p", fields: { call_id: "c-9" } },
  );

  assert.equal(replay, false, "run must not replay history: it would answer old tool calls again");
  assert.deepEqual(handled, ["check_balance"]);
  assert.equal(result, '{"account":"a1","balance":250}');
  assert.equal(said, "greet hello");
  assert.equal(ended?.reason, "caller_hangup");
  assert.equal(ended?.heardMs, 900);
  assert.equal(ended?.elapsedMs, 3000);
  assert.equal(f.joins.length, 1);
  assert.equal(f.joins[0]!.participantId, "agent-p");
  assert.equal(f.joins[0]!.customFieldsJson, '{"call_id":"c-9"}');
  assert.equal(f.leaves.length, 1);
  assert.deepEqual(
    {
      roomId: f.leaves[0]!.roomId,
      participantId: f.leaves[0]!.participantId,
      reason: f.leaves[0]!.reason,
      force: f.leaves[0]!.force,
    },
    { roomId: "room-1", participantId: "p-1", reason: "done", force: false },
  );
  // The api key went with every call.
  assert.deepEqual(f.keys, ["join=k", "run=k", "leave=k"]);
});

test("run without a handler waits for the call to end", opts, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await gate;
      stream.send({ event: { case: "sessionEnded", value: { reason: "done" } } });
    };
  });
  let finished = false;
  const running = c.run(room, support()).then(() => (finished = true));
  await sleep(100);
  assert.equal(finished, false, "run returned before the call ended");
  release();
  await running;
  assert.equal(f.leaves.length, 1);
});

test("a lost call is an error, and the agent still leaves the room", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      // The stream ends with no SessionEnded.
    };
  });
  await assert.rejects(c.run(room, support()), CallLostError);
  assert.equal(f.leaves.length, 1);
});

test("a handler that throws is rethrown, and the agent still leaves", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });
  await assert.rejects(
    c.run(room, support(), () => {
      throw new Error("handler bug");
    }),
    /handler bug/,
  );
  assert.equal(f.leaves.length, 1);
});

test("aborting run is CanceledError, and the agent still leaves", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  let handlerSignal: AbortSignal | undefined;
  await assert.rejects(
    c.run(
      room,
      support(),
      async (s, signal) => {
        handlerSignal = signal;
        for await (const _ of s.events()) {
          // Events end when the run is aborted.
        }
      },
      { signal: ac.signal },
    ),
    CanceledError,
  );
  assert.equal(handlerSignal?.aborted, true);
  // The leave is made with a fresh deadline, not the aborted signal.
  assert.equal(f.leaves.length, 1);
  assert.equal(f.leaves[0]!.reason, "done");
});

test("aborting run without a handler is CanceledError too", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(c.run(room, support(), undefined, { signal: ac.signal }), CanceledError);
  assert.equal(f.leaves.length, 1);
});

test("a run that fails to attach still leaves; one that fails to join does not", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async () => {
      throw new ConnectError("gone", Code.NotFound);
    };
  });
  await assert.rejects(c.run(room, support()), NotFoundError);
  assert.equal(f.leaves.length, 1);

  f.joinError = new ConnectError("full", Code.ResourceExhausted);
  await assert.rejects(c.run(room, support()), RoomFullError);
  assert.equal(f.leaves.length, 1, "left a room it never joined");
});

test("run validates the agent before joining, and passes allowUnlistedValues on", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      stream.send({ event: { case: "sessionEnded", value: {} } });
    };
  });
  const stored = { ...support(), voice: "NewVoice" as Voice };
  await assert.rejects(c.run(room, stored), ValidationError);
  assert.equal(f.joins.length, 0);
  await c.run(room, stored, undefined, { allowUnlistedValues: true });
  assert.equal(f.joins[0]!.profile!.voice, "NewVoice");
});

test("a leave that fails does not hide the call's own outcome", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.leaveError = new ConnectError("leave failed", Code.Internal);
    f.session = async (stream) => {
      await acceptAttach(stream);
      stream.send({ event: { case: "sessionEnded", value: {} } });
    };
  });
  await c.run(room, support());
  assert.equal(f.leaves.length, 1);
});

// Session: attach, tool answering, the event queue, commands and their
// numbering, and how a session ends.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";

import {
  CallEndedError,
  CallLostError,
  CanceledError,
  EventsInUseError,
  NotFoundError,
  Role,
  SessionClosedError,
  UnavailableError,
  ValidationError,
  p,
  tool,
  toolFromSchema,
  type Event,
  type Session,
} from "../dist/index.js";
import { acceptAttach, captureConsoleError, sleep, start, waitFor, type FakeStream } from "./fake-server.js";

const opts = { timeout: 15_000 };

/** Reads every event until the iteration ends, returning them and how it ended. */
async function drain(s: Session): Promise<{ events: Event[]; err: unknown }> {
  const events: Event[] = [];
  try {
    for await (const ev of s.events()) {
      events.push(ev);
    }
    return { events, err: undefined };
  } catch (err) {
    return { events, err };
  }
}

const ended = { event: { case: "sessionEnded", value: { reason: "done" } } } as const;

test("attach sends Attach first and needs SessionStarted back", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream, "room-1");
      stream.send(ended);
    };
  });
  const s = await c.attach("room-1");
  assert.equal(s.id, "room-1");
  const first = f.received[0]![0]!;
  assert.equal(first.event.case, "attach");
  assert.equal(first.event.case === "attach" && first.event.value.sessionId, "room-1");
  assert.equal(first.event.case === "attach" && first.event.value.replayHistory, false);
  const { err } = await drain(s);
  assert.equal(err, undefined);
  await s.close();
});

test("attach fails when the server answers with something other than SessionStarted", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await stream.recv();
      stream.send({ event: { case: "transcript", value: { text: "hi" } } });
      await sleep(50);
    };
  });
  await assert.rejects(c.attach("room-1"), /expected the session to start, got transcript/);
});

test("attach to an ended call is NotFoundError, keeping the server's message", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async () => {
      throw new ConnectError('no live session "x"', Code.NotFound);
    };
  });
  await assert.rejects(c.attach("x"), (err: unknown) => {
    assert.ok(err instanceof NotFoundError, String(err));
    assert.equal(err.serverMessage, 'no live session "x"');
    assert.match(err.message, /no live session "x"/);
    return true;
  });
});

test("attach needs a session id", opts, async (t) => {
  const { c } = await start(t);
  await assert.rejects(c.attach(""), ValidationError);
});

test("history together with tools is refused before anything is sent", opts, async (t) => {
  const { f, c } = await start(t);
  const answered = tool({ name: "t", description: "d", handler: () => undefined });
  await assert.rejects(c.attach("room-1", { history: true, tools: [answered] }), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /answer again/);
    return true;
  });
  assert.equal(f.received.length, 0, "the refused attach reached the server");
});

test("history without tools asks the server to replay", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      stream.send(ended);
    };
  });
  // A declared-only tool has no handler, so it does not conflict with history.
  const declared = tool({ name: "end_call", description: "Ends the call." });
  const s = await c.attach("room-1", { history: true, tools: [declared] });
  await drain(s);
  const attach = f.received[0]![0]!;
  assert.equal(attach.event.case === "attach" && attach.event.value.replayHistory, true);
  assert.equal(f.commands().length, 0, "a declared-only tool was claimed");
});

test("claimed tools are sent sorted, right after attach, and only those with handlers", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await stream.recv();
      stream.send(ended);
    };
  });
  const s = await c.attach("room-1", {
    tools: [
      tool({ name: "zeta", description: "d", handler: () => 1 }),
      tool({ name: "alpha", description: "d", handler: () => 1 }),
      tool({ name: "declared_only", description: "d" }),
      toolFromSchema("mid", "d", {}, [], () => 1),
    ],
  });
  await drain(s);
  const claim = f.commands()[0]!;
  assert.equal(claim.event.case, "handledTools");
  assert.deepEqual(claim.event.case === "handledTools" && claim.event.value.names, ["alpha", "mid", "zeta"]);
});

test("tools are answered without anyone reading events", opts, async (t) => {
  const results = new Map<string, string>();
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await stream.recv(); // the tool claim
      const calls: [string, string, string][] = [
        ["1", "ok", '{"n":2}'],
        ["2", "fails", ""],
        ["3", "throws", ""],
        ["4", "nothing", ""],
        ["5", "null", ""],
        ["6", "rejects", ""],
        ["7", "unencodable", ""],
        ["8", "ok", "not json"],
        ["9", "ok", '{"n":"two"}'],
        ["10", "ok", "{}"],
        ["11", "sync", ""],
      ];
      for (const [id, name, argsJson] of calls) {
        stream.send({ event: { case: "toolCall", value: { id, name, argsJson } } });
      }
      for (let i = 0; i < calls.length; i++) {
        const ev = await stream.recv();
        if (ev?.event.case === "toolResult") {
          results.set(ev.event.value.id, ev.event.value.resultJson);
        }
      }
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });

  const { logged } = await captureConsoleError(async () => {
    const s = await c.attach("room-1", {
      tools: [
        tool({
          name: "ok",
          description: "d",
          parameters: { n: p.integer("A number.") },
          handler: async ({ n }) => ({ double: n * 2 }),
        }),
        tool({ name: "fails", description: "d", handler: async () => new Error("no such account") }),
        tool({
          name: "throws",
          description: "d",
          handler: () => {
            throw new Error("bug");
          },
        }),
        tool({ name: "nothing", description: "d", handler: async () => undefined }),
        tool({ name: "null", description: "d", handler: () => null }),
        tool({ name: "rejects", description: "d", handler: () => Promise.reject(new Error("bug")) }),
        tool({ name: "unencodable", description: "d", handler: () => ({ n: 1n }) }),
        tool({ name: "sync", description: "d", handler: () => "shipped" }),
      ],
    });
    await waitFor(() => results.size === 11, 5000, "all tool results");
    await s.close();
  });

  assert.deepEqual(Object.fromEntries(results), {
    "1": '{"double":4}',
    "2": '{"error":"no such account"}',
    "3": '{"error":"the tool failed"}',
    "4": '{"ok":true}',
    "5": '{"ok":true}',
    "6": '{"error":"the tool failed"}',
    "7": '{"error":"the tool\'s result could not be encoded"}',
    "8": `{"error":"the arguments for ok were not valid: ${errorOf(() => JSON.parse("not json"))}"}`,
    "9": '{"error":"the arguments for ok were not valid: n must be an integer"}',
    "10": '{"error":"the arguments for ok were not valid: n is required"}',
    "11": '"shipped"',
  });
  // A thrown exception is a bug, so it is logged; a returned error is not.
  assert.equal(logged.length, 2);
  assert.match(String(logged[0]![0]), /tool (throws|rejects) threw/);
});

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message.replace(/"/g, '\\"');
  }
  return "";
}

test("a tool handler gets its call id, the session and a signal", opts, async (t) => {
  let seen: { id: string; sessionId: string; aborted: boolean } | undefined;
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await stream.recv();
      stream.send({ event: { case: "toolCall", value: { id: "call-7", name: "look", argsJson: "{}" } } });
      await stream.recv();
      stream.send(ended);
    };
  });
  const s = await c.attach("room-1", {
    tools: [
      tool({
        name: "look",
        description: "d",
        handler: (_args, ctx) => {
          seen = { id: ctx.id, sessionId: ctx.session.id, aborted: ctx.signal.aborted };
        },
      }),
    ],
  });
  await drain(s);
  assert.deepEqual(seen, { id: "call-7", sessionId: "room-1", aborted: false });
});

test("events are queued without bound and read in order, later", opts, async (t) => {
  const n = 2000;
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      for (let i = 0; i < n; i++) {
        stream.send({ elapsedMs: BigInt(i), event: { case: "transcript", value: { text: String(i) } } });
      }
      stream.send(ended);
    };
  });
  const s = await c.attach("room-1");
  await sleep(300); // nobody reads while the server sends everything
  const { events, err } = await drain(s);
  assert.equal(err, undefined);
  assert.equal(events.length, n + 1);
  events.slice(0, n).forEach((ev, i) => {
    assert.equal(ev.type === "transcript" && ev.text, String(i));
    assert.equal(ev.elapsedMs, i);
  });
  assert.equal(events[n]!.type, "ended");
});

test("events has one reader at a time, and can be read again after a break", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      for (const text of ["a", "b", "c"]) {
        stream.send({ event: { case: "transcript", value: { text } } });
      }
      await stream.recv(); // wait for the go-ahead
      stream.send(ended);
    };
  });
  const s = await c.attach("room-1");

  const first = s.events()[Symbol.asyncIterator]();
  const a = await first.next();
  assert.equal(!a.done && a.value.type === "transcript" && a.value.text, "a");

  // A second, concurrent reader is refused.
  await assert.rejects(s.events().next(), EventsInUseError);

  // Breaking out frees the events for the next reader, which carries on
  // where the first stopped.
  await first.return(undefined);
  const texts: string[] = [];
  for await (const ev of s.events()) {
    if (ev.type === "transcript") {
      texts.push(ev.text);
      if (ev.text === "c") {
        await s.reply("go");
      }
    }
  }
  assert.deepEqual(texts, ["b", "c"]);
});

test("a stream that ends before the call ended is a lost call", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      stream.send({ event: { case: "transcript", value: { text: "hi" } } });
      // The stream ends with no SessionEnded: what a call whose model failed
      // to connect looks like.
    };
  });
  const s = await c.attach("room-1");
  const { events, err } = await drain(s);
  assert.equal(events.length, 1, "the events before the loss were delivered");
  assert.ok(err instanceof CallLostError, String(err));
  // Reading again reports the same end.
  assert.ok((await drain(s)).err instanceof CallLostError);
});

test("a stream that fails before the call ended reports the failure", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      throw new ConnectError("worker draining", Code.Unavailable);
    };
  });
  const s = await c.attach("room-1");
  const { err } = await drain(s);
  assert.ok(err instanceof UnavailableError, String(err));
  assert.equal(err.serverMessage, "worker draining");
});

test("commands reach the server as the events it acts on; there is no say", opts, async (t) => {
  const release = deferred();
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      for (;;) {
        const ev = await stream.recv();
        if (!ev) {
          return;
        }
        if (ev.event.case === "hangup") {
          await release.promise;
          stream.send({ event: { case: "sessionEnded", value: { reason: "hangup" } } });
          return;
        }
      }
    };
  });
  const s = await c.attach("room-1");
  await s.reply("be brief");
  await s.injectContext(Role.Model, "fact");
  await s.interrupt();
  await s.hangup("done");
  release.resolve(undefined);

  // The call ends cleanly: events finishes with no error.
  assert.equal((await drain(s)).err, undefined);

  // The server has finished the stream: a further command says so.
  await assert.rejects(s.reply("late"), CallEndedError);

  await s.close();
  await assert.rejects(s.interrupt(), SessionClosedError);

  const cmds = f.commands();
  assert.equal(cmds.length, 4);
  assert.deepEqual(
    cmds.map((e) => e.event.case),
    ["generateReply", "injectContext", "interrupt", "hangup"],
  );
  const [reply, inject, , hangup] = cmds;
  assert.equal(reply!.event.case === "generateReply" && reply!.event.value.instructions, "be brief");
  assert.equal(inject!.event.case === "injectContext" && inject!.event.value.text, "fact");
  assert.equal(inject!.event.case === "injectContext" && inject!.event.value.role, "model");
  assert.equal(hangup!.event.case === "hangup" && hangup!.event.value.reason, "done");
  assert.equal(hangup!.event.case === "hangup" && hangup!.event.value.speakClosing, false);
  assert.equal("say" in s, false, "Session has a say, which the server cannot do");
});

function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test(
  "rejected events name the command their sequence number points to, counting every event after Attach",
  opts,
  async (t) => {
    const { c } = await start(t, (f) => {
      f.session = async (stream: FakeStream) => {
        await acceptAttach(stream);
        await stream.recv(); // 1: handled_tools
        stream.send({ event: { case: "toolCall", value: { id: "t1", name: "look", argsJson: "{}" } } });
        await stream.recv(); // 2: tool_result
        stream.send({ event: { case: "transcript", value: { text: "go" } } });
        await stream.recv(); // 3: reply
        await stream.recv(); // 4: interrupt
        await stream.recv(); // 5: inject_context
        await stream.recv(); // 6: hangup
        for (const ref of [1n, 2n, 3n, 4n, 5n, 6n, 99n]) {
          stream.send({ event: { case: "error", value: { sequenceRef: ref, message: `no ${ref}` } } });
        }
        stream.send(ended);
      };
    });
    const s = await c.attach("room-1", { tools: [tool({ name: "look", description: "d", handler: () => "x" })] });
    const rejected: [string, string][] = [];
    for await (const ev of s.events()) {
      if (ev.type === "transcript") {
        await s.reply();
        await s.interrupt();
        await s.injectContext(Role.User, "x");
        await s.hangup();
      }
      if (ev.type === "rejected") {
        rejected.push([ev.command, ev.message]);
      }
    }
    assert.deepEqual(rejected, [
      ["handledTools", "no 1"],
      ["toolResult", "no 2"],
      ["reply", "no 3"],
      ["interrupt", "no 4"],
      ["injectContext", "no 5"],
      ["hangup", "no 6"],
      ["", "no 99"],
    ]);
  },
);

test("rejected events are matched within the last 256 commands", opts, async (t) => {
  const total = 300;
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      for (let i = 0; i < total; i++) {
        await stream.recv();
      }
      for (const ref of [44n, 45n, 300n]) {
        stream.send({ event: { case: "error", value: { sequenceRef: ref, message: String(ref) } } });
      }
      stream.send(ended);
    };
  });
  const s = await c.attach("room-1");
  for (let i = 1; i < total; i++) {
    await s.interrupt();
  }
  await s.reply();
  const got: string[] = [];
  for await (const ev of s.events()) {
    if (ev.type === "rejected") {
      got.push(`${ev.message}:${ev.command}`);
    }
  }
  assert.deepEqual(got, ["44:", "45:interrupt", "300:reply"]);
});

test("close detaches and never hangs up; events end quietly", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      while (await stream.recv()) {
        // Record everything until the client goes away.
      }
    };
  });
  const s = await c.attach("room-1");
  await s.reply("one last thing");
  const reading = drain(s);
  await s.close();
  await s.close(); // closing twice is fine
  const { err } = await reading;
  assert.equal(err, undefined);
  await waitFor(() => f.streamEnds[0] !== "", 3000, "the server to see the client go");
  assert.deepEqual(
    f.commands().map((e) => e.event.case),
    ["generateReply"],
    "close sent something other than what was asked",
  );
  await assert.rejects(s.hangup(), SessionClosedError);
});

test("aborting the attach signal detaches: events end quietly, commands are cancelled", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });
  const ac = new AbortController();
  const s = await c.attach("room-1", { signal: ac.signal });
  const reading = drain(s);
  ac.abort();
  assert.equal((await reading).err, undefined);
  await assert.rejects(s.reply(), CanceledError);
  await s.close();
});

test("events stops early when its own signal aborts", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });
  const s = await c.attach("room-1");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  for await (const _ of s.events({ signal: ac.signal })) {
    assert.fail("no events were sent");
  }
  await s.close();
});

test("a call that ends as the tools are claimed is not an attach failure", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      stream.send(ended);
    };
  });
  const s = await c.attach("room-1", { tools: [tool({ name: "x", description: "d", handler: () => 1 })] });
  const { events, err } = await drain(s);
  assert.equal(err, undefined);
  assert.equal(events.at(-1)?.type, "ended");
});

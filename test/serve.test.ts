// serve and jobs: the inbound side.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";

import {
  AgentError,
  NotFoundError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
  tool,
  type Job,
  type Session,
} from "../dist/index.js";
import { acceptAttach, captureConsoleError, sleep, start, waitFor } from "./fake-server.js";

const opts = { timeout: 20_000 };

const answered = tool({ name: "lookup", description: "Look something up.", handler: () => "found" });

test("serve subscribes for one agent and attaches to each job without history, claiming its tools", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      const attach = await stream.recv();
      if (attach?.event.case !== "attach" || attach.event.value.replayHistory) {
        throw new ConnectError(
          "serve must not replay history: it would answer old tool calls again",
          Code.FailedPrecondition,
        );
      }
      stream.send({
        event: {
          case: "sessionStarted",
          value: { sessionId: attach.event.value.sessionId, call: { agentId: "support", fromNumber: "+91" } },
        },
      });
      await stream.recv(); // the tool claim
      stream.send({ event: { case: "sessionEnded", value: { reason: "done" } } });
    };
  });
  const ac = new AbortController();
  const calls: Session[] = [];
  const serving = c.serve(
    "support",
    [answered],
    async (s) => {
      calls.push(s);
      for await (const _ of s.events()) {
        // until the call ends
      }
    },
    { name: "test", signal: ac.signal },
  );
  f.jobs.push({ sessionId: "s-1", call: { agentId: "support" }, attachDeadlineMs: 5000 });
  await waitFor(() => calls.length === 1, 5000, "the job to reach the handler");
  assert.equal(calls[0]!.call.from, "+91");
  assert.equal(calls[0]!.id, "s-1");
  await waitFor(() => f.commands(0).length === 1, 5000, "the tool claim");
  const claim = f.commands(0)[0]!;
  assert.deepEqual(claim.event.case === "handledTools" && claim.event.value.names, ["lookup"]);

  ac.abort();
  await serving;
  assert.equal(f.subs.length, 1);
  assert.deepEqual(f.subs[0]!.agentIds, ["support"]);
  assert.equal(f.subs[0]!.clientName, "test");
  assert.deepEqual(
    f.keys.filter((k) => k.startsWith("subscribe")),
    ["subscribe=k"],
  );
});

test("serve runs handlers concurrently", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });
  const ac = new AbortController();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const serving = c.serve(
    "support",
    undefined,
    async (s) => {
      started.push(s.id);
      await gate; // the first handler holds on until the second has started
    },
    { signal: ac.signal },
  );
  f.jobs.push({ sessionId: "a" });
  f.jobs.push({ sessionId: "b" });
  await waitFor(() => started.length === 2, 5000, "both handlers to run at once");
  release();
  ac.abort();
  await serving;
});

test("a handler's exception goes to onError and serving carries on", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream, "x");
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });
  const ac = new AbortController();
  const failures: [unknown, Job | undefined][] = [];
  let served = 0;
  const serving = c.serve(
    "support",
    [],
    () => {
      served++;
      throw new Error("handler bug");
    },
    { signal: ac.signal, onError: (err, job) => failures.push([err, job]) },
  );
  f.jobs.push({ sessionId: "a", attachDeadlineMs: 5000 });
  f.jobs.push({ sessionId: "b" });
  await waitFor(() => failures.length === 2, 5000, "both failures");
  assert.equal(served, 2);
  assert.match(String(failures[0]![0]), /handler bug/);
  assert.deepEqual(failures.map(([, job]) => job?.sessionId).sort(), ["a", "b"]);
  const jobA = failures.find(([, job]) => job?.sessionId === "a")![1]!;
  assert.equal(jobA.attachByMs, 5000);
  ac.abort();
  await serving;
});

test("a job that cannot be attached to goes to onError; the default onError logs", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async () => {
      throw new ConnectError("no live session", Code.NotFound);
    };
  });
  const ac = new AbortController();
  const { logged } = await captureConsoleError(async () => {
    const serving = c.serve("support", [], () => assert.fail("a handler ran without a session"), { signal: ac.signal });
    f.jobs.push({ sessionId: "gone" });
    await waitFor(() => f.received.length === 1, 5000, "the attach");
    await sleep(100);
    ac.abort();
    await serving;
  });
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]![0]), /call gone/);
  assert.ok(logged[0]![1] instanceof NotFoundError);
});

test("serve reconnects with backoff when the server is unavailable", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.subscribeErrors.push(
      new ConnectError("restarting", Code.Unavailable),
      new ConnectError("still restarting", Code.Unavailable),
    );
    f.session = async (stream) => {
      await acceptAttach(stream);
      stream.send({ event: { case: "sessionEnded", value: {} } });
    };
  });
  const ac = new AbortController();
  const errors: [unknown, Job | undefined][] = [];
  const handled: string[] = [];
  const began = Date.now();
  const serving = c.serve("support", [], async (s) => void handled.push(s.id), {
    signal: ac.signal,
    onError: (err, job) => errors.push([err, job]),
  });
  f.jobs.push({ sessionId: "after-reconnect" });
  await waitFor(() => handled.length === 1, 10_000, "a job after reconnecting");
  const took = Date.now() - began;
  assert.equal(f.subs.length, 3);
  assert.equal(errors.length, 2);
  for (const [err, job] of errors) {
    assert.ok(err instanceof UnavailableError, String(err));
    assert.equal(job, undefined, "a lost connection is reported with no job");
  }
  assert.match(String((errors[0]![0] as Error).message), /restarting\)?; reconnecting in 1s/);
  assert.match(String((errors[1]![0] as Error).message), /reconnecting in 2s/);
  assert.ok(took >= 2900, `reconnected after ${took}ms, want the 1s then 2s backoff`);
  ac.abort();
  await serving;
});

test("other errors end serve", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.subscribeErrors.push(new ConnectError("invalid api key", Code.Unauthenticated));
  });
  await assert.rejects(
    c.serve("support", [], () => {}),
    (err: unknown) => {
      assert.ok(err instanceof UnauthorizedError);
      assert.equal(err.serverMessage, "invalid api key");
      return true;
    },
  );
  assert.equal(f.subs.length, 1);
});

test("aborting serve waits for running handlers", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      await new Promise((r) => stream.signal.addEventListener("abort", r));
    };
  });
  const ac = new AbortController();
  let handlerDone = false;
  let entered = false;
  const serving = c.serve(
    "support",
    [],
    async (_s, signal) => {
      entered = true;
      await new Promise((r) => signal.addEventListener("abort", r));
      await sleep(200); // cleaning up after the abort
      handlerDone = true;
    },
    { signal: ac.signal },
  );
  f.jobs.push({ sessionId: "a" });
  await waitFor(() => entered, 5000, "the handler");
  ac.abort();
  await serving;
  assert.equal(handlerDone, true, "serve returned before its handler finished");
});

test("serve checks its agent id and tools", opts, async (t) => {
  const { f, c } = await start(t);
  await assert.rejects(
    c.serve("", [], () => {}),
    ValidationError,
  );
  await assert.rejects(
    c.serve("support", [tool({ name: "bad name", description: "d" })], () => {}),
    /tool name "bad name"/,
  );
  await assert.rejects(
    c.serve("support", [answered, answered], () => {}),
    /declared twice/,
  );
  assert.equal(f.subs.length, 0);
});

test("jobs needs at least one agent id", opts, async (t) => {
  const { f, c } = await start(t);
  await assert.rejects(c.jobs([]).next(), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /at least one agent id/);
    return true;
  });
  assert.equal(f.subs.length, 0);
});

test("jobs delivers jobs, and breaking out ends the subscription", opts, async (t) => {
  const { f, c } = await start(t);
  f.jobs.push({
    sessionId: "s-1",
    call: { agentId: "a", callId: "c1", customFieldsJson: '{"k":"v"}' },
    attachDeadlineMs: 5000,
  });
  const got: Job[] = [];
  for await (const job of c.jobs(["a", "b"], { name: "dispatcher" })) {
    got.push(job);
    break;
  }
  assert.deepEqual(got, [
    {
      sessionId: "s-1",
      call: { callId: "c1", agentId: "a", direction: "", from: "", to: "", fields: { k: "v" } },
      attachByMs: 5000,
    },
  ]);
  assert.deepEqual(f.subs[0]!.agentIds, ["a", "b"]);
  assert.equal(f.subs[0]!.clientName, "dispatcher");
  await waitFor(() => f.subscriptionsCancelled === 1, 3000, "the subscription to be cancelled");
});

test("jobs ends quietly when its signal aborts, and reports a failed subscription", opts, async (t) => {
  const { f, c } = await start(t);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  for await (const _ of c.jobs(["a"], { signal: ac.signal })) {
    assert.fail("no jobs were offered");
  }
  f.subscribeErrors.push(new ConnectError("boom", Code.Internal));
  await assert.rejects(c.jobs(["a"]).next(), (err: unknown) => {
    assert.ok(err instanceof AgentError);
    assert.match(err.message, /subscribe: Internal: boom/);
    return true;
  });
});

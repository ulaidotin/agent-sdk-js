// gRPC status codes become the SDK's error classes, keeping the server's message.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";

import { apiError, roomError } from "../dist/errors.js";
import {
  AgentError,
  AmbiguousParticipantError,
  CallEndedError,
  CallLostError,
  CanceledError,
  CloudAccount,
  DeadlineError,
  EventsInUseError,
  InvalidRequestError,
  NotFoundError,
  NotSupportedError,
  RoomFullError,
  RoomNotFoundError,
  SessionClosedError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
  type Agent,
} from "../dist/index.js";
import { room, start } from "./fake-server.js";

const opts = { timeout: 15_000 };

const agent: Agent = {
  id: "support",
  instructions: "Be brief.",
  cloud: new CloudAccount({ project: "p", credentialsJson: "{}" }),
};

type ErrorClass = abstract new (...args: never[]) => AgentError;

const general: [Code, ErrorClass][] = [
  [Code.Unauthenticated, UnauthorizedError],
  [Code.PermissionDenied, UnauthorizedError],
  [Code.Unavailable, UnavailableError],
  [Code.InvalidArgument, InvalidRequestError],
  [Code.NotFound, NotFoundError],
  [Code.Unimplemented, NotSupportedError],
  [Code.DeadlineExceeded, DeadlineError],
  [Code.Canceled, CanceledError],
];

test("join maps the room codes, and the rest as any call does", opts, async (t) => {
  const { f, c } = await start(t);
  const roomCodes: [Code, ErrorClass][] = [
    [Code.NotFound, RoomNotFoundError],
    [Code.ResourceExhausted, RoomFullError],
    [Code.FailedPrecondition, AmbiguousParticipantError],
  ];
  for (const [code, cls] of [...roomCodes, ...general.filter(([code]) => code !== Code.NotFound)]) {
    f.joinError = new ConnectError("from the server", code);
    await assert.rejects(c.join(room, agent), (err: unknown) => {
      assert.ok(err instanceof cls, `${Code[code]}: got ${String(err)}, want ${cls.name}`);
      assert.ok(err instanceof AgentError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, cls.name);
      assert.equal(err.serverMessage, "from the server");
      assert.equal(err.grpcCode, code);
      assert.match(err.message, /^join: .*\(from the server\)$/);
      return true;
    });
  }
});

test("leave maps the room codes too", opts, async (t) => {
  const { f, c } = await start(t);
  for (const [code, cls] of [
    [Code.NotFound, RoomNotFoundError],
    [Code.ResourceExhausted, RoomFullError],
    [Code.FailedPrecondition, AmbiguousParticipantError],
    [Code.Unauthenticated, UnauthorizedError],
  ] as [Code, ErrorClass][]) {
    f.leaveError = new ConnectError("several agents", code);
    await assert.rejects(c.leave("room-1"), (err: unknown) => {
      assert.ok(err instanceof cls, `${Code[code]}: got ${String(err)}`);
      assert.match((err as Error).message, /^leave: .*\(several agents\)$/);
      return true;
    });
  }
  f.leaveError = undefined;
  assert.deepEqual(await c.leave("room-1", { participantId: "p-2", reason: "r", force: true }), {
    present: true,
    durationMs: 1500,
    heardMs: 900,
  });
  assert.deepEqual(
    { participantId: f.leaves.at(-1)!.participantId, reason: f.leaves.at(-1)!.reason, force: f.leaves.at(-1)!.force },
    { participantId: "p-2", reason: "r", force: true },
  );
  await assert.rejects(c.leave(""), ValidationError);
});

test("outside join and leave, the room codes mean nothing special", () => {
  for (const [code, cls] of general) {
    const err = apiError("attach", new ConnectError("msg", code));
    assert.ok(err instanceof cls, `${Code[code]}: ${String(err)}`);
    assert.equal(err.message, `attach: ${(cls as unknown as { description: string }).description} (msg)`);
  }
  // A code with no class of its own is an AgentError naming the code.
  for (const code of [Code.ResourceExhausted, Code.FailedPrecondition, Code.Internal, Code.Unknown, Code.Aborted]) {
    const err = apiError("receive", new ConnectError("worker crashed", code));
    assert.equal(err.constructor, AgentError, Code[code]);
    assert.equal(err.message, `receive: ${Code[code]}: worker crashed`);
    assert.equal(err.serverMessage, "worker crashed");
    assert.equal(err.grpcCode, code);
  }
  // Room codes map only for join and leave.
  assert.ok(roomError("join", new ConnectError("x", Code.NotFound)) instanceof RoomNotFoundError);
  assert.ok(apiError("attach", new ConnectError("x", Code.NotFound)) instanceof NotFoundError);
  // An AgentError passes through as it is.
  const own = new CallLostError();
  assert.equal(apiError("x", own), own);
});

test("an aborted signal is a cancellation, and a timed-out one a deadline", opts, async (t) => {
  const { c } = await start(t, (f) => {
    f.joinError = undefined;
  });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(c.join(room, agent, { signal: aborted.signal }), CanceledError);
  await assert.rejects(c.leave("room-1", { signal: AbortSignal.timeout(0) }), DeadlineError);
  await assert.rejects(c.attach("room-1", { signal: aborted.signal }), CanceledError);
});

test("every error class has its name and default message", () => {
  const all: [ErrorClass, string][] = [
    [UnauthorizedError, "unauthorized"],
    [UnavailableError, "server unavailable"],
    [InvalidRequestError, "invalid request"],
    [NotFoundError, "not found"],
    [NotSupportedError, "not supported by this server"],
    [DeadlineError, "timed out"],
    [CanceledError, "canceled"],
    [CallEndedError, "the call has ended"],
    [CallLostError, "the call was lost before it ended"],
    [SessionClosedError, "the session is closed"],
    [EventsInUseError, "the session's events are already being read"],
    [RoomNotFoundError, "room not found"],
    [RoomFullError, "room is full"],
    [AmbiguousParticipantError, "several agents in this room"],
  ];
  for (const [cls, message] of all) {
    const err = new (cls as unknown as new () => AgentError)();
    assert.equal(err.message, message);
    assert.equal(err.name, cls.name);
    assert.ok(err instanceof AgentError);
  }
  const v = new ValidationError(["a", "b"]);
  assert.deepEqual(v.problems, ["a", "b"]);
  assert.equal(v.message, "a\nb");
  assert.equal(v.name, "ValidationError");
});

// A fake agent server for the tests. It records what the SDK sends and answers
// from a script. The round trips are real: a real listener, real HTTP/2
// streams speaking gRPC, real status codes.

import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  Dispatch,
  JobSchema,
  JoinRoomResponseSchema,
  LeaveResponseSchema,
  Room,
  ServerEventSchema,
  Session,
  type ClientEvent,
  type Job,
  type JoinRoomRequest,
  type LeaveRequest,
  type ServerEvent,
  type SubscribeRequest,
} from "ulai-agent-protocol/ulai/agent/v1";

import { Client, type ClientOptions } from "../dist/index.js";

export type ServerEventInit = MessageInitShape<typeof ServerEventSchema>;
export type JobInit = MessageInitShape<typeof JobSchema>;

/** An unbounded queue that can be read with await, and closed with an error. */
export class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: (() => void)[] = [];
  #closed: { err: unknown } | undefined;

  push(v: T): void {
    this.#items.push(v);
    this.#wake();
  }

  close(err?: unknown): void {
    this.#closed ??= { err };
    this.#wake();
  }

  #wake(): void {
    for (const w of this.#waiters.splice(0)) {
      w();
    }
  }

  /** The next item, or undefined once closed or signal aborts. Throws a close error. */
  async next(signal?: AbortSignal): Promise<T | undefined> {
    for (;;) {
      if (this.#items.length > 0) {
        return this.#items.shift();
      }
      if (this.#closed) {
        if (this.#closed.err !== undefined) {
          throw this.#closed.err;
        }
        return undefined;
      }
      if (signal?.aborted) {
        return undefined;
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

/** One Session.Run stream as a script sees it. */
export interface FakeStream {
  /** The next client event; undefined once the client has stopped sending (half-close or cancel). */
  recv(): Promise<ClientEvent | undefined>;
  send(ev: ServerEventInit): void;
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
}

export type SessionScript = (stream: FakeStream) => Promise<void>;

/** The event a server sends to start a session. */
export function started(sessionId = "room-1"): ServerEventInit {
  return { sequence: 1n, event: { case: "sessionStarted", value: { sessionId } } };
}

/** A script step that answers an Attach the way the server does. */
export async function acceptAttach(stream: FakeStream, sessionId = "room-1"): Promise<ClientEvent> {
  const attach = await stream.recv();
  if (attach?.event.case !== "attach") {
    throw new ConnectError(`want an attach, got ${attach?.event.case}`, Code.FailedPrecondition);
  }
  stream.send(started(sessionId));
  return attach;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeServer {
  readonly joins: JoinRoomRequest[] = [];
  readonly leaves: LeaveRequest[] = [];
  readonly subs: SubscribeRequest[] = [];
  /** The x-api-key header of every RPC, as "method=key". */
  readonly keys: string[] = [];
  /** Every client event each session stream received, in order (including the Attach). */
  readonly received: ClientEvent[][] = [];
  /** How each session stream ended on the server side: "eof", "aborted" or "script". */
  readonly streamEnds: string[] = [];

  joinError: ConnectError | undefined;
  leaveError: ConnectError | undefined;
  /** Errors for the next subscriptions, one per subscription, before any job. */
  readonly subscribeErrors: ConnectError[] = [];
  /** Jobs to offer on the open subscription. */
  readonly jobs = new AsyncQueue<JobInit>();
  /** Aborts seen on subscriptions. */
  subscriptionsCancelled = 0;

  session: SessionScript | undefined;

  #server: http2.Http2Server | http2.Http2SecureServer | undefined;
  #sessions = new Set<http2.ServerHttp2Session>();
  port = 0;

  #key(method: string, ctx: HandlerContext): void {
    this.keys.push(`${method}=${ctx.requestHeader.get("x-api-key") ?? ""}`);
  }

  routes = (router: ConnectRouter): void => {
    router.service(Room, {
      join: async (req, ctx) => {
        this.#key("join", ctx);
        this.joins.push(req);
        if (this.joinError) {
          throw this.joinError;
        }
        return create(JoinRoomResponseSchema, {
          roomId: req.roomId,
          agentId: req.agentId,
          participantId: "p-1",
          connectionId: "c-1",
          nodeAddress: "node:443",
        });
      },
      leave: async (req, ctx) => {
        this.#key("leave", ctx);
        this.leaves.push(req);
        if (this.leaveError) {
          throw this.leaveError;
        }
        return create(LeaveResponseSchema, { wasConnected: true, durationMs: 1500n, playedMs: 900n });
      },
    });
    router.service(Session, {
      run: (requests, ctx) => this.#run(requests, ctx),
    });
    router.service(Dispatch, {
      subscribe: (req, ctx) => this.#subscribe(req, ctx),
    });
  };

  async *#run(requests: AsyncIterable<ClientEvent>, ctx: HandlerContext): AsyncGenerator<ServerEvent> {
    this.#key("run", ctx);
    const script = this.session;
    if (!script) {
      throw new ConnectError("no session script", Code.Unimplemented);
    }
    const got: ClientEvent[] = [];
    this.received.push(got);
    const index = this.streamEnds.push("") - 1;
    const it = requests[Symbol.asyncIterator]();
    const out = new AsyncQueue<ServerEvent>();
    const stream: FakeStream = {
      recv: async () => {
        try {
          const r = await it.next();
          if (r.done) {
            this.streamEnds[index] ||= "eof";
            return undefined;
          }
          got.push(r.value);
          return r.value;
        } catch {
          this.streamEnds[index] ||= "aborted";
          return undefined;
        }
      },
      send: (ev) => out.push(create(ServerEventSchema, ev)),
      signal: ctx.signal,
    };
    ctx.signal.addEventListener("abort", () => {
      this.streamEnds[index] ||= "aborted";
    });
    script(stream).then(
      () => out.close(),
      (err: unknown) => out.close(err),
    );
    for (;;) {
      const ev = await out.next();
      if (ev === undefined) {
        this.streamEnds[index] ||= "script";
        return;
      }
      yield ev;
    }
  }

  async *#subscribe(req: SubscribeRequest, ctx: HandlerContext): AsyncGenerator<Job> {
    this.#key("subscribe", ctx);
    this.subs.push(req);
    ctx.signal.addEventListener("abort", () => this.subscriptionsCancelled++);
    const err = this.subscribeErrors.shift();
    if (err) {
      throw err;
    }
    for (;;) {
      const job = await this.jobs.next(ctx.signal);
      if (job === undefined) {
        return;
      }
      yield create(JobSchema, job);
    }
  }

  /** Serves on a free port of 127.0.0.1, over TLS when given a certificate. */
  async listen(tls?: { key: string; cert: string }): Promise<void> {
    const handler = connectNodeAdapter({ routes: this.routes, grpc: true, connect: false, grpcWeb: false });
    this.#server = tls ? http2.createSecureServer({ ...tls, allowHTTP1: false }, handler) : http2.createServer(handler);
    this.#server.on("session", (s: http2.ServerHttp2Session) => {
      this.#sessions.add(s);
      s.on("close", () => this.#sessions.delete(s));
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.jobs.close();
    for (const s of this.#sessions) {
      s.destroy();
    }
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  /** The client events of session stream i, without the Attach. */
  commands(i = 0): ClientEvent[] {
    return (this.received[i] ?? []).filter((e) => e.event.case !== "attach");
  }
}

export const room = { id: "room-1", url: "https://cp.test", token: "tok" };

/** A started fake server and a client for it, cleaned up after the test. */
export async function start(
  t: { after: (fn: () => Promise<void> | void) => void },
  setup: (f: FakeServer) => void = () => {},
  options: ClientOptions = { apiKey: "k" },
): Promise<{ f: FakeServer; c: Client }> {
  const f = new FakeServer();
  setup(f);
  await f.listen();
  const c = new Client(`127.0.0.1:${f.port}`, options);
  t.after(async () => {
    c.close();
    await f.close();
  });
  return { f, c };
}

/** Waits until cond holds, or fails after ms. */
export async function waitFor(cond: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

/** Collects console.error output while fn runs. */
export async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const result = await fn();
    return { result, logged };
  } finally {
    console.error = original;
  }
}

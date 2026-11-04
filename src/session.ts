import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Client as RpcClient } from "@connectrpc/connect";
import {
  ClientEventSchema,
  Session as SessionService,
  type ClientEvent,
  type ServerEvent,
} from "ulai-agent-protocol/ulai/agent/v1";

import {
  abortError,
  AgentError,
  apiError,
  CallEndedError,
  CallLostError,
  EventsInUseError,
  SessionClosedError,
  ValidationError,
} from "./errors.js";
import { eventFrom, type Event, type RejectedCommand, type ToolCall } from "./events.js";
import type { Role } from "./models.js";
import { toolInternals, type Tool, type ToolContext, type ToolRunner } from "./tools.js";
import { backendInfoFrom, callInfoFrom, type BackendInfo, type CallInfo } from "./types.js";

/** Options for {@link Client.attach}. */
export interface AttachOptions {
  /**
   * Replays what the call has already said before live events, for a client
   * attaching mid-call. It cannot be combined with tools that have handlers:
   * the replay includes past tool calls, which would be answered a second time.
   */
  history?: boolean;
  /** Tools this client answers. Tools without a handler are ignored. */
  tools?: readonly Tool[];
  /** Detaches the session when aborted, as {@link Session.close} does. */
  signal?: AbortSignal;
}

/** Options for {@link Session.events}. */
export interface EventsOptions {
  /** Stops reading when aborted: the iteration ends without an error. */
  signal?: AbortSignal;
}

/** How many recent commands a rejected event can be matched to. */
const rejectWindow = 256;

/** How long close waits for the server to end the stream after the client stops sending. */
const closeFlushMs = 1000;

interface Outgoing {
  msg: ClientEvent;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Outbox is the request side of a session's stream: the transport pulls from
 * it, and each send resolves once the transport has taken its message.
 */
class Outbox implements AsyncIterable<ClientEvent> {
  #items: Outgoing[] = [];
  #waiters: ((r: IteratorResult<ClientEvent>) => void)[] = [];
  #ended = false;
  #failure: { err: unknown } | undefined;

  push(msg: ClientEvent): Promise<void> {
    if (this.#failure) {
      return Promise.reject(this.#failure.err);
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = this.#waiters.shift();
      if (waiter) {
        resolve();
        waiter({ value: msg, done: false });
        return;
      }
      this.#items.push({ msg, resolve, reject });
    });
  }

  /** Ends the stream once the messages already pushed are taken. */
  end(): void {
    this.#ended = true;
    if (this.#items.length === 0) {
      this.#finishWaiters();
    }
  }

  /** Fails every message not yet taken, and ends the stream. */
  fail(err: unknown): void {
    this.#failure ??= { err };
    const items = this.#items;
    this.#items = [];
    for (const item of items) {
      item.reject(this.#failure.err);
    }
    this.#finishWaiters();
  }

  #finishWaiters(): void {
    for (const w of this.#waiters.splice(0)) {
      w({ value: undefined, done: true });
    }
  }

  #next(): Promise<IteratorResult<ClientEvent>> {
    const item = this.#items.shift();
    if (item) {
      item.resolve();
      return Promise.resolve({ value: item.msg, done: false });
    }
    if (this.#ended || this.#failure) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<ClientEvent> {
    return {
      next: () => this.#next(),
      // The transport throws into the iterator when it can no longer send,
      // and returns it when it stops early: either way, nothing more goes out.
      throw: () => {
        this.fail(new CallEndedError());
        return Promise.resolve({ value: undefined, done: true });
      },
      return: () => {
        this.fail(new CallEndedError());
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

type Next = { event: Event } | { done: true; err: unknown };

/**
 * EventQueue holds a session's events until events() reads them. Unbounded,
 * so a client that is slow to read never stops tool calls being answered.
 */
class EventQueue {
  #items: (Event | undefined)[] = [];
  #head = 0;
  #done = false;
  #err: unknown = undefined;
  #wake: (() => void)[] = [];

  push(ev: Event): void {
    this.#items.push(ev);
    this.#signal();
  }

  finish(err: unknown): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#err = err;
    this.#signal();
  }

  #signal(): void {
    for (const w of this.#wake.splice(0)) {
      w();
    }
  }

  /** The next event, or how the queue ended. Undefined when signal aborted first. */
  async next(signal: AbortSignal | undefined): Promise<Next | undefined> {
    for (;;) {
      if (this.#head < this.#items.length) {
        const event = this.#items[this.#head] as Event;
        this.#items[this.#head] = undefined;
        this.#head++;
        if (this.#head >= 1024 && this.#head * 2 >= this.#items.length) {
          this.#items = this.#items.slice(this.#head);
          this.#head = 0;
        }
        return { event };
      }
      if (this.#done) {
        return { done: true, err: this.#err };
      }
      if (signal?.aborted) {
        return undefined;
      }
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          this.#wake = this.#wake.filter((w) => w !== wake);
          resolve();
        };
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        this.#wake.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

/** The Session service client. */
export type SessionRpc = RpcClient<typeof SessionService>;

type AttachFn = (rpc: SessionRpc, sessionId: string, options?: AttachOptions) => Promise<Session>;
let attachImpl: AttachFn;

/**
 * attachSession follows and steers a running call: it sends an Attach, waits
 * for the session to start, claims the tools this client answers, and starts
 * receiving in the background.
 */
export function attachSession(rpc: SessionRpc, sessionId: string, options?: AttachOptions): Promise<Session> {
  return attachImpl(rpc, sessionId, options);
}

const encodeFailure = '{"error":"the tool\'s result could not be encoded"}';

/**
 * runTool calls a handler and encodes what it says for the model. A handler
 * that throws is reported to the model as a failed tool rather than taking the
 * session, and every call on it, down.
 */
async function runTool(run: ToolRunner, call: ToolCall, context: ToolContext): Promise<string> {
  let out: unknown;
  try {
    const res = await run(call.argsJson, context);
    if (res instanceof Error) {
      out = { error: res.message };
    } else if (res === undefined || res === null) {
      out = { ok: true };
    } else {
      out = res;
    }
  } catch (err) {
    console.error(`ulai-agents: tool ${call.name} threw:`, err);
    out = { error: "the tool failed" };
  }
  try {
    return JSON.stringify(out) ?? encodeFailure;
  } catch {
    return encodeFailure;
  }
}

interface SessionInit {
  id: string;
  call: CallInfo;
  backend: BackendInfo;
  outbox: Outbox;
  controller: AbortController;
  userSignal: AbortSignal | undefined;
  unlink: () => void;
  tools: Map<string, ToolRunner>;
}

/**
 * One live call, attached: you see what happens on it and steer it.
 *
 * From the moment attach resolves, the session receives in the background and
 * answers tool calls as they arrive, whether or not anything is reading
 * {@link Session.events}.
 *
 * Commands steer the call. Each resolves once the command is sent; the server
 * applies it asynchronously, and reports one it cannot apply as a `rejected`
 * event naming the command. Commands sent in the first second or two of a
 * call, before the model is connected, are rejected.
 */
export class Session {
  /** The session's id: for a call started with join, its room id. */
  readonly id: string;
  /** Describes the call. */
  readonly call: CallInfo;
  /** Describes what is running the call. */
  readonly backend: BackendInfo;

  readonly #outbox: Outbox;
  readonly #controller: AbortController;
  readonly #userSignal: AbortSignal | undefined;
  readonly #unlink: () => void;
  readonly #tools: Map<string, ToolRunner>;
  readonly #queue = new EventQueue();

  // seq numbers each event sent after the Attach, as the server numbers
  // them, so a rejected event can name the command it refuses.
  #seq = 0;
  readonly #sent = new Map<number, RejectedCommand>();

  #closed = false;
  #finished = false;
  #reading = false;
  #loop: Promise<void> = Promise.resolve();

  private constructor(init: SessionInit) {
    this.id = init.id;
    this.call = init.call;
    this.backend = init.backend;
    this.#outbox = init.outbox;
    this.#controller = init.controller;
    this.#userSignal = init.userSignal;
    this.#unlink = init.unlink;
    this.#tools = init.tools;
  }

  /**
   * Everything that happens on the call, in order, until it ends. Read it
   * with `for await`; one reader at a time, though a loop that breaks out can
   * be followed by another. Steer the call from anywhere, including from
   * inside the loop.
   *
   * It ends with an error when the call was lost rather than ended: a
   * {@link CallLostError} when the server dropped it (a call whose model
   * failed to connect, for instance), or a connection error. It ends quietly
   * when the session is closed or its signal aborts, or when `options.signal`
   * aborts.
   */
  async *events(options: EventsOptions = {}): AsyncGenerator<Event, void, undefined> {
    if (this.#reading) {
      throw new EventsInUseError();
    }
    this.#reading = true;
    try {
      for (;;) {
        const next = await this.#queue.next(options.signal);
        if (next === undefined) {
          return;
        }
        if ("event" in next) {
          yield next.event;
          continue;
        }
        if (next.err !== undefined) {
          throw next.err;
        }
        return;
      }
    } finally {
      this.#reading = false;
    }
  }

  /** Asks the model to speak now, optionally with instructions for what to say. */
  async reply(instructions = ""): Promise<void> {
    return this.#send("reply", { case: "generateReply", value: { instructions } });
  }

  /**
   * Tells the model something without it being spoken: a lookup that
   * finished mid-call, an action taken elsewhere.
   */
  async injectContext(role: Role, text: string): Promise<void> {
    return this.#send("injectContext", { case: "injectContext", value: { role, text } });
  }

  /** Stops the agent mid-sentence. */
  async interrupt(): Promise<void> {
    return this.#send("interrupt", { case: "interrupt", value: {} });
  }

  /** Ends the call now. */
  async hangup(reason = ""): Promise<void> {
    return this.#send("hangup", { case: "hangup", value: { reason } });
  }

  /**
   * Detaches from the call. It does not hang up: the call carries on, on the
   * agent's instructions.
   *
   * The session stops sending and tells the server so; the server, having
   * read every command sent before, ends the stream. A server that has not
   * done so within a second is cut off.
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#outbox.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.#loop,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, closeFlushMs);
        }),
      ]);
      clearTimeout(timer);
      this.#controller.abort(new SessionClosedError());
    }
    await this.#loop;
  }

  /** The command a rejected event's sequence number refers to. */
  #commandFor(ref: bigint): RejectedCommand | "" {
    return this.#sent.get(Number(ref)) ?? "";
  }

  #send(command: RejectedCommand, event: MessageInitShape<typeof ClientEventSchema>["event"]): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new SessionClosedError());
    }
    if (this.#userSignal?.aborted) {
      return Promise.reject(abortError(command, this.#userSignal));
    }
    if (this.#finished) {
      return Promise.reject(new CallEndedError());
    }
    this.#seq++;
    this.#sent.set(this.#seq, command);
    if (this.#seq > rejectWindow) {
      this.#sent.delete(this.#seq - rejectWindow);
    }
    return this.#outbox.push(create(ClientEventSchema, { event }));
  }

  /** answer runs a tool's handler in the background, so a slow lookup does not hold up the events behind it. */
  #answer(call: ToolCall): void {
    const run = this.#tools.get(call.name);
    if (!run) {
      return;
    }
    const context: ToolContext = { id: call.id, session: this, signal: this.#controller.signal };
    void (async () => {
      const resultJson = await runTool(run, call, context);
      try {
        await this.#send("toolResult", { case: "toolResult", value: { id: call.id, name: call.name, resultJson } });
      } catch {
        // The call ended or the session closed: there is no one to answer.
      }
    })();
  }

  /** receive reads the stream until it ends, answering tools and queueing every event. */
  async #receive(responses: AsyncIterator<ServerEvent>): Promise<void> {
    let ended = false;
    let failure: unknown = undefined;
    try {
      for (;;) {
        const r = await responses.next();
        if (r.done) {
          // The server finished the stream. Without an ended event first,
          // the call failed to start or was dropped.
          if (!ended) {
            failure = new CallLostError();
          }
          break;
        }
        const ev = eventFrom(r.value, (ref) => this.#commandFor(ref));
        if (ev === undefined) {
          continue;
        }
        if (ev.type === "toolCall") {
          this.#answer(ev);
        } else if (ev.type === "ended") {
          ended = true;
        }
        this.#queue.push(ev);
      }
    } catch (err) {
      if (!ended) {
        failure = apiError("receive", err, this.#userSignal);
      }
    }
    const detached = this.#closed || this.#userSignal?.aborted === true;
    this.#finished = true;
    this.#outbox.fail(
      this.#closed
        ? new SessionClosedError()
        : this.#userSignal?.aborted
          ? abortError("send", this.#userSignal)
          : new CallEndedError(),
    );
    this.#queue.finish(detached ? undefined : failure);
    this.#unlink();
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new CallEndedError());
    }
  }

  static {
    attachImpl = async (rpc, sessionId, options = {}) => {
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new ValidationError("attach needs a session id");
      }
      const tools = new Map<string, ToolRunner>();
      for (const t of options.tools ?? []) {
        const run = toolInternals(t)?.run;
        if (run) {
          tools.set(t.name, run);
        }
      }
      if (options.history && tools.size > 0) {
        throw new ValidationError(
          "history replays past tool calls, which tools would answer again; attach without history to answer tools",
        );
      }
      const userSignal = options.signal;
      if (userSignal?.aborted) {
        throw abortError("attach", userSignal);
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort(userSignal?.reason);
      userSignal?.addEventListener("abort", onAbort, { once: true });
      const unlink = () => userSignal?.removeEventListener("abort", onAbort);

      const outbox = new Outbox();
      outbox
        .push(
          create(ClientEventSchema, {
            event: { case: "attach", value: { sessionId, replayHistory: !!options.history } },
          }),
        )
        .catch(() => {
          // Reported by the first receive below.
        });
      const responses = rpc.run(outbox, { signal: controller.signal })[Symbol.asyncIterator]();

      // The server answers an Attach with SessionStarted, or with an error such
      // as NotFound for a call that has ended.
      const fail = (err: AgentError): never => {
        outbox.fail(new CallEndedError());
        controller.abort(err);
        unlink();
        throw err;
      };
      let first: IteratorResult<ServerEvent>;
      try {
        first = await responses.next();
      } catch (err) {
        return fail(apiError("attach", err, userSignal));
      }
      if (first.done) {
        return fail(new AgentError(`attach ${sessionId}: the server ended the stream before the session started`));
      }
      const ev = first.value.event;
      if (ev.case !== "sessionStarted") {
        return fail(new AgentError(`attach ${sessionId}: expected the session to start, got ${ev.case ?? "nothing"}`));
      }

      const s = new Session({
        id: ev.value.sessionId,
        call: callInfoFrom(ev.value.call),
        backend: backendInfoFrom(ev.value.backend),
        outbox,
        controller,
        userSignal,
        unlink,
        tools,
      });

      // Claim the tools this client answers, so the server waits for our answer
      // instead of answering them itself. It is sent before anything else.
      let claim: Promise<void> | undefined;
      if (tools.size > 0) {
        const names = [...tools.keys()].sort();
        claim = s.#send("handledTools", { case: "handledTools", value: { names } });
      }
      s.#loop = s.#receive(responses);
      if (claim) {
        try {
          await claim;
        } catch (err) {
          // A call that ended as we attached is not an attach failure: the
          // events say how it ended.
          if (!(err instanceof CallEndedError)) {
            await s.close();
            throw err;
          }
        }
      }
      return s;
    };
  }
}

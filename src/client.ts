import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

import { create } from "@bufbuild/protobuf";
import { createClient, type Client as RpcClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  Dispatch as DispatchService,
  JoinRoomRequestSchema,
  LeaveRequestSchema,
  Room as RoomService,
  Session as SessionService,
  SubscribeRequestSchema,
  MediaTransport,
} from "ulai-agent-protocol/ulai/agent/v1";

import { agentProblems, agentProfile, openingToPB, type Agent } from "./agent.js";
import { Transport } from "./models.js";
import { apiError, CanceledError, roomError, UnavailableError, ValidationError } from "./errors.js";
import { Seat, type LeaveOptions, type LeaveResult, type RoomLike } from "./room.js";
import { attachSession, type AttachOptions, type Session } from "./session.js";
import { toolProblems, type Tool } from "./tools.js";
import { callInfoFrom, type CallInfo } from "./types.js";

/** Options for {@link Client}. */
export interface ClientOptions {
  /** Authenticates every call with the key the server was configured with. Sent as `x-api-key`. */
  apiKey?: string;
  /**
   * Encrypts the connection, verifying the server against the system's root
   * certificates. Use it anywhere but this machine: an agent's configuration
   * carries cloud credentials.
   */
  tls?: boolean;
  /**
   * Allows an unencrypted connection to an address that is not this machine.
   * An agent's cloud key and room token travel with every call, so use it
   * only on a network you trust end to end.
   */
  insecure?: boolean;
  /**
   * PEM certificates to verify the server against instead of the system's:
   * a self-signed certificate, or an internal CA. Implies `tls`.
   */
  rootCertificates?: string | Uint8Array;
}

/** Options for {@link Client.join}. */
export interface JoinOptions {
  /** Names the agent's participant in the room. */
  participantId?: string;
  /**
   * Custom fields for the call, such as your own call id. They come back in
   * `session.call.fields`, and `call_id` becomes `session.call.callId`.
   */
  fields?: Record<string, unknown>;
  /**
   * Sends models, voices, languages and the other listed values even when
   * this SDK does not know them, leaving the server to refuse a bad one. For
   * a platform that forwards agents stored in its own database; an agent
   * written in code should use the constants instead. Ranges and structure
   * are still checked.
   */
  allowUnlistedValues?: boolean;
  /** Abandons the request when aborted. */
  signal?: AbortSignal;
}

/** Options for {@link Client.run}. */
export interface RunOptions extends JoinOptions {
  /**
   * Ends the call's handling when aborted: the session detaches, the agent
   * leaves the room, and run throws a {@link CanceledError}.
   */
  signal?: AbortSignal;
}

/**
 * An agent's own logic for one call. It runs until it returns or the call
 * ends; `signal` aborts when run or serve is told to stop.
 */
export type Handler = (session: Session, signal: AbortSignal) => unknown;

/** A call the server offers this client: already running on the agent's instructions, and yours once you attach. */
export interface Job {
  sessionId: string;
  call: CallInfo;
  /** How long the call waits for a client before carrying on without one. */
  attachByMs: number;
}

/** Options for {@link Client.jobs}. */
export interface JobsOptions {
  /** Names this client in the server's logs. */
  name?: string;
  /** Ends the subscription when aborted; the iteration ends without an error. */
  signal?: AbortSignal;
}

/** Options for {@link Client.serve}. */
export interface ServeOptions extends JobsOptions {
  /**
   * Receives calls that could not be attached to, errors thrown by handlers,
   * and lost connections to the server (with no job). By default they are
   * logged with console.error. Serving carries on either way.
   */
  onError?: (error: unknown, job: Job | undefined) => void;
  /** Stops serving when aborted; serve then waits for running handlers and returns. */
  signal?: AbortSignal;
}

/** The address as a URL for the transport, with the host it names. */
function parseAddress(address: string, tls: boolean): { baseUrl: string; host: string } {
  const addr = address.replace(/^(dns:\/\/\/|passthrough:\/\/\/)/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(addr) || addr.startsWith("unix:")) {
    throw new ValidationError(`${address}: give the server's address as host:port`);
  }
  let url: URL;
  try {
    url = new URL(`${tls ? "https" : "http"}://${addr}`);
  } catch {
    throw new ValidationError(`${address} is not a host:port address`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new ValidationError(`${address} is not a host:port address`);
  }
  if (url.port === "") {
    url.port = "443"; // gRPC's default port
  }
  return { baseUrl: url.origin, host: url.hostname.replace(/^\[|\]$/g, "") };
}

/** isLocal reports whether host is this machine. */
export function isLocal(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") {
    return true;
  }
  switch (isIP(h)) {
    case 4:
      return h.startsWith("127.");
    case 6:
      // ::1, and 127.0.0.0/8 mapped into IPv6.
      return h === "::1" || /^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(h);
    default:
      return false;
  }
}

function checkCertificates(pem: string | Uint8Array): void {
  const text = typeof pem === "string" ? pem : Buffer.from(pem).toString("utf8");
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  for (const block of blocks) {
    try {
      new X509Certificate(block);
      return;
    } catch {
      // Try the next one.
    }
  }
  throw new ValidationError("rootCertificates: no certificates in the PEM given");
}

/** The header the server reads the API key from. */
const apiKeyHeader = "x-api-key";

/** Waits ms, or less if signal aborts first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A controller that aborts with parent, and a function to stop following it. */
function follow(parent: AbortSignal | undefined): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  if (!parent) {
    return { controller, unlink: () => {} };
  }
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    onAbort();
  } else {
    parent.addEventListener("abort", onAbort, { once: true });
  }
  return { controller, unlink: () => parent.removeEventListener("abort", onAbort) };
}

/** untilEnded waits for the call to end, reporting a call that was lost. */
async function untilEnded(session: Session): Promise<void> {
  for await (const _ of session.events()) {
    // Only the end matters.
  }
}

function defaultOnError(error: unknown, job: Job | undefined): void {
  if (job) {
    console.error(`ulai-agents: call ${job.sessionId}:`, error);
  } else {
    console.error("ulai-agents: serve:", error);
  }
}

/** How long run waits for the agent to leave the room. */
const leaveTimeoutMs = 10_000;

/**
 * A connection to an agent server. One client serves every call a process
 * makes.
 *
 * It does not dial until first used, so a server that is down is reported by
 * the first call, as an {@link UnavailableError}.
 *
 * Without `tls` the connection is unencrypted, which is allowed only to this
 * machine (localhost, 127.0.0.1, ::1, an SSH tunnel). Anything else needs
 * `tls: true`, or `insecure: true`.
 */
export class Client {
  readonly #rooms: RpcClient<typeof RoomService>;
  readonly #sessions: RpcClient<typeof SessionService>;
  readonly #dispatch: RpcClient<typeof DispatchService>;
  readonly #connection: Http2SessionManager;

  /** A client for the agent server at address, as host:port. */
  constructor(address: string, options: ClientOptions = {}) {
    if (typeof address !== "string" || address === "") {
      throw new ValidationError("Client needs the server's address");
    }
    const { apiKey, insecure, rootCertificates } = options;
    if (rootCertificates !== undefined) {
      checkCertificates(rootCertificates);
    }
    const tls = options.tls === true || rootCertificates !== undefined;
    const { baseUrl, host } = parseAddress(address, tls);
    if (!tls && !insecure && !isLocal(host)) {
      throw new ValidationError(
        `${address} is not this machine, and an unencrypted connection would carry the agent's credentials in the clear: use { tls: true }, or { insecure: true } on a network you trust`,
      );
    }

    const nodeOptions =
      rootCertificates === undefined
        ? {}
        : { ca: typeof rootCertificates === "string" ? rootCertificates : Buffer.from(rootCertificates) };
    this.#connection = new Http2SessionManager(baseUrl, {}, nodeOptions);
    const interceptors: Interceptor[] = [];
    if (apiKey) {
      interceptors.push((next) => (req) => {
        req.header.set(apiKeyHeader, apiKey);
        return next(req);
      });
    }
    const transport = createGrpcTransport({ baseUrl, sessionManager: this.#connection, interceptors });
    this.#rooms = createClient(RoomService, transport);
    this.#sessions = createClient(SessionService, transport);
    this.#dispatch = createClient(DispatchService, transport);
  }

  /**
   * Puts an agent in a room. It resolves once the agent has a seat, not once
   * it is talking: the model connects a second or two later.
   *
   * The agent is validated first; a {@link ValidationError} lists every
   * problem. The call's session id, for attach, is `room.id`.
   */
  async join(room: RoomLike, agent: Agent, options: JoinOptions = {}): Promise<Seat> {
    const problems = agentProblems(agent, !options.allowUnlistedValues);
    if (typeof room?.id !== "string" || room.id === "") {
      problems.push("join needs room.id: the server never creates rooms");
    }
    if (typeof room?.url !== "string" || room.url === "") {
      problems.push("join needs room.url, the control plane holding the room");
    }
    // Not a list check: these are the only two the server can dial.
    const transport = transportToPB(room?.transport);
    if (transport === undefined) {
      problems.push(`unknown room.transport ${JSON.stringify(room.transport)}: use Transport.WebSocket or Transport.WebRTC`);
    }
    let fields = "";
    if (options.fields && Object.keys(options.fields).length > 0) {
      try {
        fields = JSON.stringify(options.fields);
      } catch (err) {
        problems.push(`fields could not be encoded: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (problems.length > 0) {
      throw new ValidationError(problems);
    }

    const request = create(JoinRoomRequestSchema, {
      agentId: agent.id,
      roomId: room.id,
      participantId: options.participantId ?? "",
      customFieldsJson: fields,
      opening: openingToPB(agent.opening),
      roomUrl: room.url,
      roomToken: room.token ?? "",
      profile: agentProfile(agent),
      transport: transport ?? MediaTransport.UNSPECIFIED,
    });
    let resp;
    try {
      resp = await this.#rooms.join(request, { signal: options.signal });
    } catch (err) {
      throw roomError("join", err, options.signal);
    }
    return new Seat(
      {
        room: resp.roomId,
        agentId: resp.agentId,
        participantId: resp.participantId,
        connectionId: resp.connectionId,
        node: resp.nodeAddress,
      },
      (roomId, o) => this.leave(roomId, o),
    );
  }

  /** Takes an agent out of a room, whoever put it there. */
  async leave(roomId: string, options: LeaveOptions = {}): Promise<LeaveResult> {
    if (typeof roomId !== "string" || roomId === "") {
      throw new ValidationError("leave needs a room id");
    }
    const request = create(LeaveRequestSchema, {
      roomId,
      participantId: options.participantId ?? "",
      reason: options.reason ?? "",
      force: options.force ?? false,
    });
    let resp;
    try {
      resp = await this.#rooms.leave(request, { signal: options.signal });
    } catch (err) {
      throw roomError("leave", err, options.signal);
    }
    return { present: resp.wasConnected, durationMs: Number(resp.durationMs), heardMs: Number(resp.playedMs) };
  }

  /**
   * Follows and steers a running call. The session id of a call started with
   * join is its room id.
   *
   * Close the session when you are done. Closing detaches; the call carries on.
   */
  attach(sessionId: string, options: AttachOptions = {}): Promise<Session> {
    return attachSession(this.#sessions, sessionId, options);
  }

  /**
   * The whole outbound call in one step: puts the agent in the room, attaches
   * with the agent's tools, runs handler, and takes the agent out of the room
   * when handler returns, throws, or `signal` aborts.
   *
   * Without a handler the call runs on the agent's instructions alone, until
   * it ends. A call the server lost is thrown as a {@link CallLostError}.
   */
  async run(room: RoomLike, agent: Agent, handler?: Handler, options: RunOptions = {}): Promise<void> {
    const { signal } = options;
    const seat = await this.join(room, agent, options);
    try {
      const session = await this.attach(room.id, { tools: agent.tools, signal });
      const { controller, unlink } = follow(signal);
      try {
        await (handler ?? untilEnded)(session, controller.signal);
      } finally {
        unlink();
        await session.close();
      }
      if (signal?.aborted) {
        throw new CanceledError(`run: ${CanceledError.description}`, { cause: signal.reason });
      }
    } finally {
      // Leave even when signal has aborted, or the agent stays in the room.
      await seat.leave("done", { signal: AbortSignal.timeout(leaveTimeoutMs) }).catch(() => {});
    }
  }

  /**
   * The inbound side: runs handler on every call for agentId as each one
   * starts, concurrently, answering tools. It runs until `signal` aborts, then
   * waits for running handlers.
   *
   * An inbound call already runs on the configuration it was started with,
   * so serve takes only the agent's id and the tools this client answers.
   *
   * A call is offered to every client serving its agent, not to one of them.
   * Run one serve per agent: two would both attach to every call, and the one
   * that claimed tools last would answer them.
   *
   * When the server goes away, serve reconnects with backoff (1s, doubling to
   * 30s), reporting each attempt to `onError`. Other errors end it.
   */
  async serve(
    agentId: string,
    tools: readonly Tool[] | undefined,
    handler?: Handler,
    options: ServeOptions = {},
  ): Promise<void> {
    if (typeof agentId !== "string" || agentId === "") {
      throw new ValidationError("serve needs an agent id");
    }
    const problems = toolProblems(tools, "tools");
    if (problems.length > 0) {
      throw new ValidationError(problems);
    }
    const h = handler ?? untilEnded;
    const onError = options.onError ?? defaultOnError;
    const report = (err: unknown, job: Job | undefined) => {
      try {
        onError(err, job);
      } catch (e) {
        console.error("ulai-agents: serve: onError threw:", e);
      }
    };
    const { signal } = options;

    const running = new Set<Promise<void>>();
    let backoff = 1000;
    try {
      for (;;) {
        let connected = false;
        try {
          for await (const job of this.jobs([agentId], { name: options.name, signal })) {
            connected = true;
            backoff = 1000;
            const p: Promise<void> = this.#serveOne(job, tools, h, report, signal).finally(() => running.delete(p));
            running.add(p);
          }
        } catch (err) {
          if (!(err instanceof UnavailableError) || signal?.aborted) {
            throw err;
          }
          report(
            new UnavailableError(`${err.message}; reconnecting in ${backoff / 1000}s`, {
              cause: err,
              serverMessage: err.serverMessage,
              grpcCode: err.grpcCode,
            }),
            undefined,
          );
        }
        if (signal?.aborted) {
          return;
        }
        if (!connected) {
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    } finally {
      await Promise.allSettled(running);
    }
  }

  async #serveOne(
    job: Job,
    tools: readonly Tool[] | undefined,
    handler: Handler,
    report: (err: unknown, job: Job | undefined) => void,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const { controller, unlink } = follow(signal);
    try {
      let session: Session;
      try {
        // No history: the job is offered as the call starts, and a replay
        // would answer its tool calls a second time.
        session = await this.attach(job.sessionId, { tools, signal: controller.signal });
      } catch (err) {
        report(err, job);
        return;
      }
      try {
        await handler(session, controller.signal);
      } catch (err) {
        report(err, job);
      } finally {
        await session.close();
      }
    } finally {
      unlink();
      controller.abort();
    }
  }

  /**
   * Calls for these agents as the server starts them, for a client that
   * dispatches them itself: its own queue, a concurrency limit. Attach to a
   * job's sessionId to take it.
   */
  async *jobs(agentIds: readonly string[], options: JobsOptions = {}): AsyncGenerator<Job, void, undefined> {
    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      // The server reads an empty list as every agent, which on a shared
      // server means taking other people's calls.
      throw new ValidationError("jobs needs at least one agent id");
    }
    const { signal } = options;
    if (signal?.aborted) {
      return;
    }
    const { controller, unlink } = follow(signal);
    try {
      const request = create(SubscribeRequestSchema, { agentIds: [...agentIds], clientName: options.name ?? "" });
      const stream = this.#dispatch.subscribe(request, { signal: controller.signal })[Symbol.asyncIterator]();
      for (;;) {
        let r;
        try {
          r = await stream.next();
        } catch (err) {
          if (signal?.aborted) {
            return;
          }
          throw apiError("subscribe", err);
        }
        if (r.done) {
          return;
        }
        yield { sessionId: r.value.sessionId, call: callInfoFrom(r.value.call), attachByMs: r.value.attachDeadlineMs };
      }
    } finally {
      unlink();
      controller.abort();
    }
  }

  /** Releases the connection. Calls in progress on the server carry on. */
  close(): void {
    this.#connection.abort();
  }
}

/** The proto value for a room's transport; undefined for one no server knows. */
function transportToPB(t: unknown): MediaTransport | undefined {
  switch (t) {
    case undefined:
    case "":
      return MediaTransport.UNSPECIFIED;
    case Transport.WebSocket:
      return MediaTransport.WEBSOCKET;
    case Transport.WebRTC:
      return MediaTransport.WEBRTC;
    default:
      return undefined;
  }
}

import { Code, ConnectError } from "@connectrpc/connect";

/** Options for constructing an {@link AgentError}. */
export interface AgentErrorOptions {
  /** The underlying failure. */
  cause?: unknown;
  /** The server's own message, when the server gave one. */
  serverMessage?: string;
  /** The gRPC status code the server answered with, when it did. */
  grpcCode?: number;
}

/**
 * The base class of every error this SDK throws. Test for a particular failure
 * with `instanceof`, e.g. `err instanceof RoomFullError`; the server's own
 * message is kept in {@link AgentError.serverMessage} and in the message text.
 */
export class AgentError extends Error {
  /** The server's own message, when the server gave one. */
  readonly serverMessage: string | undefined;
  /** The gRPC status code the server answered with, when it did. */
  readonly grpcCode: number | undefined;

  constructor(message: string, options: AgentErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.serverMessage = options.serverMessage;
    this.grpcCode = options.grpcCode;
  }
}

/** The API key was missing or wrong. */
export class UnauthorizedError extends AgentError {
  static readonly description = "unauthorized";
  constructor(message: string = UnauthorizedError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** The server could not be reached or is not taking work. Worth a retry. */
export class UnavailableError extends AgentError {
  static readonly description = "server unavailable";
  constructor(message: string = UnavailableError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** The server rejected the request as malformed. */
export class InvalidRequestError extends AgentError {
  static readonly description = "invalid request";
  constructor(message: string = InvalidRequestError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** The thing named does not exist: a session that has ended, for instance. */
export class NotFoundError extends AgentError {
  static readonly description = "not found";
  constructor(message: string = NotFoundError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/**
 * This server does not serve that: a build that runs no calls of its own, or
 * a server on another protocol version.
 */
export class NotSupportedError extends AgentError {
  static readonly description = "not supported by this server";
  constructor(message: string = NotSupportedError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** The deadline passed before an answer came back. */
export class DeadlineError extends AgentError {
  static readonly description = "timed out";
  constructor(message: string = DeadlineError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** The operation was cancelled: its AbortSignal fired. */
export class CanceledError extends AgentError {
  static readonly description = "canceled";
  constructor(message: string = CanceledError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** A command was sent to a call that has already ended. */
export class CallEndedError extends AgentError {
  static readonly description = "the call has ended";
  constructor(message: string = CallEndedError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/**
 * The server dropped the call without it ending: most often its model failed
 * to connect (check `agent.cloud`), or the call was torn down.
 */
export class CallLostError extends AgentError {
  static readonly description = "the call was lost before it ended";
  constructor(message: string = CallLostError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** A command was sent after {@link Session.close}. */
export class SessionClosedError extends AgentError {
  static readonly description = "the session is closed";
  constructor(message: string = SessionClosedError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** A second, concurrent reader of {@link Session.events}. */
export class EventsInUseError extends AgentError {
  static readonly description = "the session's events are already being read";
  constructor(message: string = EventsInUseError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** The room does not exist, or has ended. */
export class RoomNotFoundError extends AgentError {
  static readonly description = "room not found";
  constructor(message: string = RoomNotFoundError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/** The room is at its participant limit. Retrying may work once someone leaves. */
export class RoomFullError extends AgentError {
  static readonly description = "room is full";
  constructor(message: string = RoomFullError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/**
 * The room holds several agents and leave did not say which one: pass
 * `participantId`.
 */
export class AmbiguousParticipantError extends AgentError {
  static readonly description = "several agents in this room";
  constructor(message: string = AmbiguousParticipantError.description, options?: AgentErrorOptions) {
    super(message, options);
  }
}

/**
 * Something was given to the SDK that it cannot send: an agent with a missing
 * field or an unknown voice, a room without an id. `problems` lists every one
 * found, not just the first.
 */
export class ValidationError extends AgentError {
  readonly problems: readonly string[];
  constructor(problems: string | readonly string[]) {
    const list = typeof problems === "string" ? [problems] : [...problems];
    super(list.join("\n"));
    this.problems = list;
  }
}

type SentinelClass = (new (message?: string, options?: AgentErrorOptions) => AgentError) & {
  readonly description: string;
};

function sentinelFor(code: Code): SentinelClass | undefined {
  switch (code) {
    case Code.Unauthenticated:
    case Code.PermissionDenied:
      return UnauthorizedError;
    case Code.Unavailable:
      return UnavailableError;
    case Code.InvalidArgument:
      return InvalidRequestError;
    case Code.NotFound:
      return NotFoundError;
    case Code.Unimplemented:
      return NotSupportedError;
    case Code.DeadlineExceeded:
      return DeadlineError;
    case Code.Canceled:
      return CanceledError;
    default:
      return undefined;
  }
}

function make(cls: SentinelClass, op: string, ce: ConnectError | undefined, cause: unknown): AgentError {
  const serverMessage = ce?.rawMessage || undefined;
  const text = serverMessage ? `${op}: ${cls.description} (${serverMessage})` : `${op}: ${cls.description}`;
  return new cls(text, { cause, serverMessage, grpcCode: ce?.code });
}

/** The error an aborted signal stands for: a timeout or a cancellation. */
export function abortError(op: string, signal: AbortSignal): AgentError {
  const reason: unknown = signal.reason;
  if (reason instanceof AgentError) {
    return reason;
  }
  const isTimeout = reason instanceof Error && reason.name === "TimeoutError";
  return make(isTimeout ? DeadlineError : CanceledError, op, undefined, reason);
}

/**
 * apiError turns a failed call into one of the errors above, keeping the
 * server's message. A signal that was aborted decides between a timeout and a
 * cancellation, which the transport reports alike.
 */
export function apiError(op: string, err: unknown, signal?: AbortSignal): AgentError {
  if (err instanceof AgentError) {
    return err;
  }
  if (signal?.aborted) {
    return abortError(op, signal);
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return make(err.name === "TimeoutError" ? DeadlineError : CanceledError, op, undefined, err);
  }
  const ce = ConnectError.from(err);
  const cls = sentinelFor(ce.code);
  if (cls) {
    return make(cls, op, ce, err);
  }
  const serverMessage = ce.rawMessage || undefined;
  return new AgentError(`${op}: ${Code[ce.code] ?? ce.code}: ${ce.rawMessage}`, {
    cause: err,
    serverMessage,
    grpcCode: ce.code,
  });
}

/**
 * roomError is apiError for join and leave, where three codes mean something
 * specific about the room.
 */
export function roomError(op: string, err: unknown, signal?: AbortSignal): AgentError {
  if (err instanceof ConnectError && !signal?.aborted) {
    switch (err.code) {
      case Code.NotFound:
        return make(RoomNotFoundError, op, err, err);
      case Code.ResourceExhausted:
        return make(RoomFullError, op, err, err);
      case Code.FailedPrecondition:
        return make(AmbiguousParticipantError, op, err, err);
    }
  }
  return apiError(op, err, signal);
}

import { inspect, type InspectOptionsStylized } from "node:util";

import type { Transport } from "./models.js";

/**
 * A room that already exists, and where it lives. The server never creates
 * rooms: an agent alone in a room nobody was told about would talk to no one.
 *
 * A plain `{ id, url, token }` object works anywhere a room is wanted; a
 * {@link Room} also keeps its token out of logs.
 */
export interface RoomLike {
  /** The room. Required. */
  readonly id: string;
  /** The control plane that holds the room. Required. */
  readonly url: string;
  /** Authenticates to that control plane. */
  readonly token?: string;
  /**
   * How the agent server carries the room's audio to the media server:
   * `Transport.WebSocket` or `Transport.WebRTC`. Unset is WebSocket.
   */
  readonly transport?: Transport;
}

const redacted = (secret: string): string => (secret === "" ? "" : "[redacted]");

/**
 * A room, with its token kept out of `toString()`, `JSON.stringify` and
 * `console.log`.
 */
export class Room implements RoomLike {
  readonly id: string;
  readonly url: string;
  readonly transport?: Transport;
  readonly #token: string;

  constructor(room: RoomLike) {
    this.id = room.id;
    this.url = room.url;
    this.#token = room.token ?? "";
    if (room.transport !== undefined) {
      this.transport = room.transport;
    }
  }

  /** Authenticates to the control plane. */
  get token(): string {
    return this.#token;
  }

  toString(): string {
    const transport = this.transport ? ` transport:${this.transport}` : "";
    return `Room{id:${this.id} url:${this.url} token:${redacted(this.#token)}${transport}}`;
  }

  toJSON(): { id: string; url: string; token: string; transport?: Transport } {
    return { id: this.id, url: this.url, token: redacted(this.#token), ...(this.transport ? { transport: this.transport } : {}) };
  }

  [inspect.custom](_depth: number, options: InspectOptionsStylized, show: typeof inspect): string {
    return `Room ${show(this.toJSON(), options)}`;
  }
}

/** Says which agent leaves a room, and how. */
export interface LeaveOptions {
  /** The agent to take out. Needed when the room holds several. */
  participantId?: string;
  reason?: string;
  /** Takes the agent out without its closing line. */
  force?: boolean;
  /** Abandons the request when aborted. */
  signal?: AbortSignal;
}

/** What an agent's time in a room amounted to. */
export interface LeaveResult {
  /** False when the agent was already gone. Leave still succeeds. */
  present: boolean;
  durationMs: number;
  /** How much agent audio the caller heard. */
  heardMs: number;
}

/** What a seat is made from. */
export interface SeatInit {
  room: string;
  agentId: string;
  participantId: string;
  connectionId: string;
  node: string;
}

type LeaveFn = (roomId: string, options: LeaveOptions) => Promise<LeaveResult>;

/** An agent's place in a room, as join returns it. */
export class Seat {
  /** The room. */
  readonly room: string;
  readonly agentId: string;
  /** The agent's participant in the room. */
  readonly participantId: string;
  /** Changes on every rejoin, which is why leave keys on participantId instead. */
  readonly connectionId: string;
  /** The media server the room is on, for log correlation. */
  readonly node: string;
  readonly #leave: LeaveFn;

  /** Seats come from {@link Client.join}. */
  constructor(init: SeatInit, leave: LeaveFn) {
    this.room = init.room;
    this.agentId = init.agentId;
    this.participantId = init.participantId;
    this.connectionId = init.connectionId;
    this.node = init.node;
    this.#leave = leave;
  }

  /** Takes this agent out of its room. */
  leave(reason = "", options: { force?: boolean; signal?: AbortSignal } = {}): Promise<LeaveResult> {
    return this.#leave(this.room, { participantId: this.participantId, reason, ...options });
  }
}

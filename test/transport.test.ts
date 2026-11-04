import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { MediaTransport } from "ulai-agent-protocol/ulai/agent/v1";
import { CloudAccount, Room, Transport, ValidationError, type Agent } from "../dist/index.js";
import { room, start } from "./fake-server.js";

const agent: Agent = {
  id: "support",
  instructions: "Be brief.",
  cloud: new CloudAccount({ project: "p", credentialsJson: "{}" }),
};

test("the room's transport is sent, and unset leaves the server's default", async (t) => {
  for (const [transport, want] of [
    [undefined, MediaTransport.UNSPECIFIED],
    [Transport.WebSocket, MediaTransport.WEBSOCKET],
    [Transport.WebRTC, MediaTransport.WEBRTC],
  ] as const) {
    const { f, c } = await start(t);
    await c.join({ ...room, transport }, agent);
    assert.equal(f.joins.at(-1)?.transport, want, `transport ${transport}`);
  }
});

test("an unknown transport is refused before anything is sent", async (t) => {
  const { f, c } = await start(t);
  await assert.rejects(
    c.join({ ...room, transport: "quic" as Transport }, agent, { allowUnlistedValues: true }),
    (err: unknown) => err instanceof ValidationError && /room\.transport "quic"/.test((err as Error).message),
  );
  assert.equal(f.joins.length, 0);
});

test("a Room shows its transport but never its token", () => {
  const r = new Room({ ...room, transport: Transport.WebRTC });
  for (const s of [String(r), JSON.stringify(r), inspect(r)]) {
    assert.match(s, /webrtc/);
    assert.doesNotMatch(s, /tok"|:tok\b|'tok'/);
  }
});

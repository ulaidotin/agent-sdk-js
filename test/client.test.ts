// The connection: where plaintext is allowed, TLS with a private CA, the API key.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isLocal } from "../dist/client.js";
import { AgentError, Client, CloudAccount, UnavailableError, ValidationError, type Agent } from "../dist/index.js";
import { acceptAttach, FakeServer, room, start } from "./fake-server.js";

const opts = { timeout: 15_000 };

const agent: Agent = {
  id: "support",
  instructions: "Be brief.",
  cloud: new CloudAccount({ project: "p", credentialsJson: "{}" }),
};

test("plaintext is allowed only to this machine", () => {
  for (const addr of [
    "127.0.0.1:50052",
    "localhost:50052",
    "LOCALHOST:1",
    "[::1]:50052",
    "dns:///localhost:50052",
    "127.8.9.10:1",
    "[::ffff:127.0.0.1]:1",
  ]) {
    assert.doesNotThrow(() => new Client(addr).close(), addr);
  }
  for (const addr of [
    "agents.example.com:443",
    "10.0.0.5:50052",
    "[2001:db8::1]:443",
    "localhost.example.com:1",
    "128.0.0.1:1",
  ]) {
    assert.throws(
      () => new Client(addr),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, addr);
        assert.match(err.message, /not this machine.*tls: true.*insecure: true/s);
        return true;
      },
      addr,
    );
    assert.doesNotThrow(() => new Client(addr, { tls: true }).close(), `${addr} with tls`);
    assert.doesNotThrow(() => new Client(addr, { insecure: true }).close(), `${addr} with insecure`);
  }
});

test("isLocal knows this machine", () => {
  assert.equal(isLocal("localhost"), true);
  assert.equal(isLocal("127.0.0.1"), true);
  assert.equal(isLocal("::1"), true);
  assert.equal(isLocal("::ffff:7f00:1"), true);
  assert.equal(isLocal("0.0.0.0"), false);
  assert.equal(isLocal("example.com"), false);
});

test("the address must be a host and port", () => {
  assert.throws(() => new Client(""), ValidationError);
  assert.throws(() => new Client("https://agents.example.com"), /give the server's address as host:port/);
  assert.throws(() => new Client("unix:/tmp/agent.sock"), /host:port/);
  assert.throws(() => new Client("localhost:1/path"), /is not a host:port address/);
});

test("rootCertificates must hold a certificate", () => {
  assert.throws(
    () => new Client("agents.example.com:443", { rootCertificates: "not a pem" }),
    /no certificates in the PEM given/,
  );
  assert.throws(
    () =>
      new Client("agents.example.com:443", {
        rootCertificates: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
      }),
    /no certificates/,
  );
});

test("the API key is sent as x-api-key on every RPC", opts, async (t) => {
  const { f, c } = await start(t, (f) => {
    f.session = async (stream) => {
      await acceptAttach(stream);
      stream.send({ event: { case: "sessionEnded", value: {} } });
    };
  });
  const seat = await c.join(room, agent);
  const s = await c.attach("room-1");
  for await (const _ of s.events()) {
    // until ended
  }
  await seat.leave("bye");
  f.jobs.push({ sessionId: "x" });
  for await (const _ of c.jobs(["support"])) {
    break;
  }
  assert.deepEqual(f.keys, ["join=k", "run=k", "leave=k", "subscribe=k"]);
});

test("without an API key, none is sent", opts, async (t) => {
  const { f, c } = await start(t, () => {}, {});
  await c.join(room, agent);
  assert.deepEqual(f.keys, ["join="]);
});

test("a server that is not there is UnavailableError", opts, async () => {
  // A port nothing listens on.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const c = new Client(`127.0.0.1:${port}`);
  try {
    await assert.rejects(c.join(room, agent), UnavailableError);
  } finally {
    c.close();
  }
});

/** A self-signed certificate for localhost, made with openssl, or undefined without it. */
async function selfSigned(): Promise<{ key: string; cert: string } | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "ulai-agents-tls-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  } catch {
    return undefined;
  }
  return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
}

test("TLS against a private CA with rootCertificates", opts, async (t) => {
  const tls = await selfSigned();
  if (!tls) {
    t.skip("openssl is not available to make a certificate");
    return;
  }
  const f = new FakeServer();
  await f.listen(tls);
  t.after(() => f.close());

  const trusted = new Client(`localhost:${f.port}`, { rootCertificates: tls.cert, apiKey: "k" });
  const seat = await trusted.join(room, agent);
  assert.equal(seat.participantId, "p-1");
  trusted.close();

  // The same certificate as bytes works too.
  const bytes = new Client(`localhost:${f.port}`, { rootCertificates: new TextEncoder().encode(tls.cert) });
  await bytes.join(room, agent);
  bytes.close();

  // Without it, the server's certificate is not trusted, and nothing is sent.
  const untrusted = new Client(`localhost:${f.port}`, { tls: true });
  await assert.rejects(untrusted.join(room, agent), (err: unknown) => {
    assert.ok(err instanceof AgentError, String(err));
    assert.match(err.message, /certificate/);
    return true;
  });
  untrusted.close();
  assert.equal(f.joins.length, 2);
});

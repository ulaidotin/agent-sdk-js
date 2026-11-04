// Tools: what the model is told, and what a handler is given.

import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { AgentProfileSchema } from "ulai-agent-protocol/ulai/agent/v1";

import { agentProfile } from "../dist/agent.js";
import { toolInternals, toolProblems } from "../dist/tools.js";
import { CloudAccount, p, tool, toolFromSchema, type Session, type Tool, type ToolContext } from "../dist/index.js";

const context: ToolContext = { id: "c1", session: {} as Session, signal: new AbortController().signal };

/** Runs a tool's handler as the session does, on raw JSON arguments. */
function call(t: Tool, argsJson: string): Promise<unknown> {
  const run = toolInternals(t)?.run;
  assert.ok(run, `${t.name} has no handler`);
  return run(argsJson, context);
}

test("tool() describes its parameters to the model", () => {
  const t = tool({
    name: "book",
    description: "Book a slot.",
    parameters: {
      day: p.string("The day.", { enum: ["mon", "tue"] }),
      guests: p.integer("How many.", { enum: [1, 2, 4] }).optional(),
      price: p.number("Most to pay.").optional(),
      vip: p.boolean("A VIP?"),
      note: p.string(),
    },
    handler: () => "ok",
  });
  assert.equal(t.name, "book");
  assert.equal(t.description, "Book a slot.");
  assert.equal(t.handled, true);
  assert.deepEqual(t.parameters, {
    day: { type: "string", description: "The day.", enum: ["mon", "tue"] },
    guests: { type: "integer", description: "How many.", enum: ["1", "2", "4"] },
    price: { type: "number", description: "Most to pay.", enum: undefined },
    vip: { type: "boolean", description: "A VIP?", enum: undefined },
    note: { type: "string", description: "", enum: undefined },
  });
  assert.deepEqual(t.required, ["day", "vip", "note"]);
  assert.ok(Object.isFrozen(t));
  assert.deepEqual(toolProblems([t], "tools"), []);

  // On the wire.
  const profile = agentProfile({
    id: "a",
    instructions: "x",
    cloud: new CloudAccount({ project: "p", credentialsJson: "{}" }),
    tools: [t, tool({ name: "ping", description: "Ping." })],
  });
  const spec = profile.tools[0]!;
  assert.deepEqual(spec.required, ["day", "vip", "note"]);
  assert.deepEqual(spec.parameters.guests!.enum, ["1", "2", "4"]);
  assert.equal(spec.parameters.vip!.type, "boolean");
  assert.deepEqual(profile.tools[1]!.parameters, {}, "a tool with no parameters sends none");
  assert.ok(create(AgentProfileSchema, profile));
});

test("a tool without a handler is declared, not answered", () => {
  const t = tool({ name: "end_call", description: "Ends the call." });
  assert.equal(t.handled, false);
  assert.equal(toolInternals(t)?.run, undefined);
  assert.equal(toolFromSchema("x", "d", undefined).handled, false);
});

test("a typed handler gets exactly its declared parameters, checked", async () => {
  let got: unknown;
  const t = tool({
    name: "check",
    description: "d",
    parameters: {
      account: p.string(),
      n: p.integer().optional(),
      rate: p.number().optional(),
      on: p.boolean().optional(),
    },
    handler: (args) => {
      got = args;
      return "ok";
    },
  });
  assert.equal(await call(t, '{"account":"a1","n":3,"rate":1.5,"on":true,"extra":"dropped"}'), "ok");
  assert.deepEqual(got, { account: "a1", n: 3, rate: 1.5, on: true });
  // Missing optional parameters, and nulls, are left out.
  assert.equal(await call(t, '{"account":"a1","n":null}'), "ok");
  assert.deepEqual(got, { account: "a1" });

  const invalid = async (json: string) => ((await call(t, json)) as Error).message;
  assert.equal(await invalid('{"n":1}'), "the arguments for check were not valid: account is required");
  assert.equal(await invalid('{"account":1}'), "the arguments for check were not valid: account must be a string");
  assert.equal(
    await invalid('{"account":"a","n":1.5}'),
    "the arguments for check were not valid: n must be an integer",
  );
  assert.equal(
    await invalid('{"account":"a","rate":"x"}'),
    "the arguments for check were not valid: rate must be a number",
  );
  assert.equal(
    await invalid('{"account":"a","on":"yes"}'),
    "the arguments for check were not valid: on must be a boolean",
  );
  assert.equal(await invalid("[1]"), "the arguments for check were not valid: expected a JSON object");
  assert.match(await invalid("{"), /^the arguments for check were not valid: /);

  // No arguments at all is an empty object.
  const none = tool({ name: "none", description: "d", handler: (args) => (got = args) });
  await call(none, "");
  assert.deepEqual(got, {});
  await call(none, "null");
  assert.deepEqual(got, {});
});

test("toolFromSchema describes run-time parameters and hands over the arguments as they came", async () => {
  let got: Record<string, unknown> | undefined;
  const t = toolFromSchema(
    "lookup_order",
    "Look up an order.",
    {
      order_id: { type: "string", description: "The order." },
      express: { type: "boolean" },
      tier: { type: "string", enum: ["gold", "silver"] },
    },
    ["order_id"],
    (args, ctx) => {
      got = args;
      assert.equal(ctx.id, "c1");
      return "shipped";
    },
  );
  assert.deepEqual(toolProblems([t], "tools"), []);
  assert.equal(t.parameters.express!.type, "boolean");
  assert.deepEqual(t.parameters.tier!.enum, ["gold", "silver"]);
  assert.deepEqual(t.required, ["order_id"]);
  assert.equal(await call(t, '{"order_id":"o-1","express":true,"other":5}'), "shipped");
  assert.deepEqual(got, { order_id: "o-1", express: true, other: 5 });
  // No checking of types: the schema is the platform's, and so are its arguments.
  await call(t, '{"order_id":7}');
  assert.deepEqual(got, { order_id: 7 });
  assert.match(((await call(t, "nope")) as Error).message, /^the arguments for lookup_order were not valid/);
});

test("a schema with an unknown type or a stray required name is refused", () => {
  const cases: [Tool, RegExp][] = [
    [toolFromSchema("t", "d", { x: { type: "array" as never } }), /tool t: parameter x has type "array"/],
    [
      toolFromSchema("t", "d", { x: { type: "string" } }, ["y"]),
      /tool t: required parameter y is not among its parameters/,
    ],
    [
      tool({ name: "t", description: "d", parameters: { x: { type: "date" } as never } }),
      /parameter x has type "date"; use p\.string/,
    ],
  ];
  for (const [t, want] of cases) {
    const problems = toolProblems([t], "tools");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, want);
  }
  assert.deepEqual(toolProblems("nope", "tools"), ["tools must be an array of tools"]);
});

test("parameters are immutable, and optional() returns a new one", () => {
  const required = p.string("x");
  const optional = required.optional();
  assert.equal(required.required, true);
  assert.equal(optional.required, false);
  assert.equal(optional.description, "x");
  assert.ok(Object.isFrozen(required));
});

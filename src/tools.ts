import { create } from "@bufbuild/protobuf";
import { ToolParamSchema, ToolSpecSchema, type ToolParam, type ToolSpec } from "ulai-agent-protocol/ulai/agent/v1";

import type { Session } from "./session.js";

/** The JSON type of a tool parameter. */
export type ParamType = "string" | "boolean" | "integer" | "number";

const paramTypes: ReadonlySet<string> = new Set<ParamType>(["string", "boolean", "integer", "number"]);

/** A tool parameter as the model is told about it. */
export interface ParamSchema {
  readonly type: ParamType;
  readonly description: string;
  /** When set, the value must be one of these. */
  readonly enum: readonly string[] | undefined;
}

declare const argType: unique symbol;

/**
 * One parameter of a tool, built with {@link p}. `T` is the type the handler
 * receives; `Required` is false once `.optional()` was called.
 */
export interface Param<T = unknown, Required extends boolean = true> extends ParamSchema {
  readonly required: Required;
  /** The parameter, but optional: the model may leave it out. */
  optional(): Param<T, false>;
  /** Carries the argument's type for {@link ToolArgs}; never set. */
  readonly [argType]?: T;
}

/** A tool's parameters: a name for each. */
export type Params = Readonly<Record<string, Param<unknown, boolean>>>;

type ArgOf<X> = X extends Param<infer T, boolean> ? T : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * The arguments a handler receives for parameters `P`: a required parameter is
 * always present, an optional one may be missing.
 */
export type ToolArgs<P extends Params> = Simplify<
  { -readonly [K in keyof P as P[K] extends Param<unknown, true> ? K : never]: ArgOf<P[K]> } & {
    -readonly [K in keyof P as P[K] extends Param<unknown, true> ? never : K]?: ArgOf<P[K]>;
  }
>;

class ParamImpl<T, R extends boolean> implements Param<T, R> {
  readonly type: ParamType;
  readonly description: string;
  readonly enum: readonly string[] | undefined;
  readonly required: R;

  constructor(type: ParamType, description: string, values: readonly (string | number)[] | undefined, required: R) {
    this.type = type;
    this.description = description;
    this.enum = values && values.length > 0 ? Object.freeze(values.map(String)) : undefined;
    this.required = required;
    Object.freeze(this);
  }

  optional(): Param<T, false> {
    return new ParamImpl<T, false>(this.type, this.description, this.enum, false);
  }
}

type NonEmpty<T> = readonly [T, ...T[]];

function stringParam(description?: string): Param<string>;
function stringParam<const E extends NonEmpty<string>>(description: string, options: { enum: E }): Param<E[number]>;
function stringParam(description?: string, options?: { enum?: readonly string[] }): Param<string>;
function stringParam(description = "", options?: { enum?: readonly string[] }): Param<string> {
  return new ParamImpl<string, true>("string", description, options?.enum, true);
}

function integerParam(description?: string): Param<number>;
function integerParam<const E extends NonEmpty<number>>(description: string, options: { enum: E }): Param<E[number]>;
function integerParam(description?: string, options?: { enum?: readonly number[] }): Param<number>;
function integerParam(description = "", options?: { enum?: readonly number[] }): Param<number> {
  return new ParamImpl<number, true>("integer", description, options?.enum, true);
}

function numberParam(description?: string): Param<number>;
function numberParam<const E extends NonEmpty<number>>(description: string, options: { enum: E }): Param<E[number]>;
function numberParam(description?: string, options?: { enum?: readonly number[] }): Param<number>;
function numberParam(description = "", options?: { enum?: readonly number[] }): Param<number> {
  return new ParamImpl<number, true>("number", description, options?.enum, true);
}

function booleanParam(description = ""): Param<boolean> {
  return new ParamImpl<boolean, true>("boolean", description, undefined, true);
}

/**
 * Builders for tool parameters. Each parameter is required unless
 * `.optional()` is called on it; `description` tells the model what it is, and
 * `enum` limits it to a list of values.
 *
 * ```ts
 * parameters: {
 *   account: p.string("The account number."),
 *   kind: p.string("Which balance.", { enum: ["savings", "current"] }).optional(),
 * }
 * ```
 */
export const p = Object.freeze({
  string: stringParam,
  boolean: booleanParam,
  integer: integerParam,
  number: numberParam,
});

/** What a tool handler is told besides its arguments. */
export interface ToolContext {
  /** The id of this tool call. */
  readonly id: string;
  /** The session the call came in on. */
  readonly session: Session;
  /** Aborted when the session ends or is closed. */
  readonly signal: AbortSignal;
}

/**
 * A tool handler. Its result is sent back to the model as JSON; undefined or
 * null is sent as `{"ok": true}`. To tell the model the tool failed, *return*
 * an Error: its message is sent as `{"error": message}` so the model can
 * apologise or try something else. An exception that is thrown is a bug, and
 * the model is told only `{"error": "the tool failed"}`.
 */
export type ToolHandler<A> = (args: A, context: ToolContext) => unknown;

/** A tool's definition, for {@link tool}. */
export interface ToolDefinition<P extends Params> {
  /** What the model calls the tool: letters, digits, `_ . -`, at most 64. */
  name: string;
  /** How the model knows when to call it. Required. */
  description: string;
  /** The tool's parameters, built with {@link p}. */
  parameters?: P;
  /**
   * Answers the tool. Without one the tool is declared to the model but this
   * client does not answer it.
   */
  handler?: ToolHandler<ToolArgs<P>>;
}

/**
 * Something the agent can do: a function the model may call. Build one with
 * {@link tool} or {@link toolFromSchema}.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, ParamSchema>>;
  /** The parameters the model must always pass. */
  readonly required: readonly string[];
  /** Whether this client answers the tool, rather than only declaring it. */
  readonly handled: boolean;
}

/** Decodes a call's JSON arguments and runs the handler. */
export type ToolRunner = (argsJson: string, context: ToolContext) => Promise<unknown>;

interface ToolInternals {
  run: ToolRunner | undefined;
  error: string | undefined;
}

const internals = new WeakMap<object, ToolInternals>();

/** The handler and construction error of a tool built here, or undefined. */
export function toolInternals(t: unknown): ToolInternals | undefined {
  return typeof t === "object" && t !== null ? internals.get(t) : undefined;
}

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, ParamSchema>,
  required: string[],
  run: ToolRunner | undefined,
  error: string | undefined,
): Tool {
  const t: Tool = Object.freeze({
    name,
    description,
    parameters: Object.freeze(parameters),
    required: Object.freeze(required),
    handled: run !== undefined,
  });
  internals.set(t, { run, error });
  return t;
}

function invalidArgs(name: string, why: string): Error {
  return new Error(`the arguments for ${name} were not valid: ${why}`);
}

/** Parses a call's arguments as a JSON object, or explains why they are not one. */
function parseArgs(name: string, raw: string): Record<string, unknown> | Error {
  if (raw.trim() === "") {
    return {};
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return invalidArgs(name, e instanceof Error ? e.message : String(e));
  }
  if (v === null) {
    return {};
  }
  if (typeof v !== "object" || Array.isArray(v)) {
    return invalidArgs(name, "expected a JSON object");
  }
  return v as Record<string, unknown>;
}

function matchesType(type: ParamType, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
  }
}

const anA: Record<ParamType, string> = {
  string: "a string",
  boolean: "a boolean",
  integer: "an integer",
  number: "a number",
};

/**
 * Declares a tool and its handler. The handler's argument types come from
 * `parameters`:
 *
 * ```ts
 * const checkBalance = tool({
 *   name: "check_balance",
 *   description: "Look up the balance of an account.",
 *   parameters: { account: p.string("The account number.") },
 *   handler: async ({ account }) => ({ account, balance: 250 }),
 * });
 * ```
 *
 * The arguments are checked against the parameters before the handler runs:
 * a missing required one, or one of the wrong type, is reported to the model
 * as an error.
 */
export function tool<P extends Params = {}>(definition: ToolDefinition<P>): Tool {
  const { name, description, handler } = definition;
  const params: Record<string, ParamSchema> = {};
  const required: string[] = [];
  let error: string | undefined;
  for (const [pname, param] of Object.entries(definition.parameters ?? {})) {
    const type = (param as Partial<ParamSchema> | undefined)?.type;
    if (typeof type !== "string" || !paramTypes.has(type)) {
      error ??= `tool ${name}: parameter ${pname} has type ${JSON.stringify(type)}; use p.string, p.boolean, p.integer or p.number`;
      continue;
    }
    params[pname] = { type, description: param.description ?? "", enum: param.enum };
    if (param.required !== false) {
      required.push(pname);
    }
  }

  let run: ToolRunner | undefined;
  if (typeof handler === "function") {
    run = async (raw, context) => {
      const parsed = parseArgs(name, raw);
      if (parsed instanceof Error) {
        return parsed;
      }
      // Only the declared parameters reach the handler, each of its type.
      const args: Record<string, unknown> = {};
      const wrong: string[] = [];
      for (const [pname, param] of Object.entries(params)) {
        const v = parsed[pname];
        if (v === undefined || v === null) {
          if (required.includes(pname)) {
            wrong.push(`${pname} is required`);
          }
          continue;
        }
        if (!matchesType(param.type, v)) {
          wrong.push(`${pname} must be ${anA[param.type]}`);
          continue;
        }
        args[pname] = v;
      }
      if (wrong.length > 0) {
        return invalidArgs(name, wrong.join("; "));
      }
      return handler(args as ToolArgs<P>, context);
    };
  }
  return makeTool(name, description, params, required, run, error);
}

/** One parameter of a tool built with {@link toolFromSchema}. */
export interface ParamDefinition {
  type: ParamType;
  description?: string;
  /** When set, limits the value to these. */
  enum?: readonly string[];
}

/**
 * Declares a tool whose parameters are only known at run time (read from a
 * database, say) rather than written in code. The handler gets the model's
 * arguments as a plain object, unchecked.
 *
 * Without a handler the tool is declared but not answered here.
 */
export function toolFromSchema(
  name: string,
  description: string,
  params: Readonly<Record<string, ParamDefinition>> | undefined,
  required: readonly string[] = [],
  handler?: ToolHandler<Record<string, unknown>>,
): Tool {
  const schema: Record<string, ParamSchema> = {};
  let error: string | undefined;
  for (const [pname, param] of Object.entries(params ?? {})) {
    const type = (param as Partial<ParamDefinition> | undefined)?.type;
    if (typeof type !== "string" || !paramTypes.has(type)) {
      error ??= `tool ${name}: parameter ${pname} has type ${JSON.stringify(type)}; use "string", "boolean", "integer" or "number"`;
    }
    schema[pname] = {
      type: type as ParamType,
      description: param?.description ?? "",
      enum: param?.enum && param.enum.length > 0 ? Object.freeze([...param.enum]) : undefined,
    };
  }
  for (const r of required) {
    if (!Object.hasOwn(schema, r)) {
      error ??= `tool ${name}: required parameter ${r} is not among its parameters`;
    }
  }

  let run: ToolRunner | undefined;
  if (typeof handler === "function") {
    run = async (raw, context) => {
      const args = parseArgs(name, raw);
      return args instanceof Error ? args : handler(args, context);
    };
  }
  return makeTool(name, description, schema, [...required], run, error);
}

/** What the models accept as a function name. */
const toolName = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** Every problem with tools, as validate reports them. */
export function toolProblems(tools: unknown, where: string): string[] {
  if (tools === undefined || tools === null) {
    return [];
  }
  if (!Array.isArray(tools)) {
    return [`${where} must be an array of tools`];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  tools.forEach((t: unknown, i) => {
    const inner = toolInternals(t);
    if (!inner) {
      problems.push(`${where}[${i}] is not a tool: build it with tool() or toolFromSchema()`);
      return;
    }
    const { name, description } = t as Tool;
    if (inner.error) {
      problems.push(inner.error);
    } else if (typeof name !== "string" || !toolName.test(name)) {
      problems.push(
        `tool name ${JSON.stringify(name)} must start with a letter or underscore and use only letters, digits, _ . -, at most 64 characters`,
      );
    } else if (typeof description !== "string" || description.trim() === "") {
      problems.push(`tool ${JSON.stringify(name)} needs a description: it is how the model knows when to call it`);
    }
    if (seen.has(name)) {
      problems.push(`tool ${JSON.stringify(name)} is declared twice`);
    }
    seen.add(name);
  });
  return problems;
}

/** A tool on the wire. */
export function toolSpec(t: Tool): ToolSpec {
  const parameters: Record<string, ToolParam> = {};
  for (const [name, param] of Object.entries(t.parameters)) {
    parameters[name] = create(ToolParamSchema, {
      type: param.type,
      description: param.description,
      enum: [...(param.enum ?? [])],
    });
  }
  return create(ToolSpecSchema, { name: t.name, description: t.description, parameters, required: [...t.required] });
}

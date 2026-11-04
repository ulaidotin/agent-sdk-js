// basic is a complete voice agent in one file.
//
//   node examples/basic.ts --mode join --room <room-id> --room-url <url> --room-token <token>
//   node examples/basic.ts --mode serve
//
// (Node 23.6 and later run TypeScript directly; on older versions use
// `npx tsx examples/basic.ts`. Run `npm run build` first.)
//
// The server address and key come from ULAI_ADDR and ULAI_API_KEY; the Google
// Cloud project the models run in from GOOGLE_CLOUD_PROJECT and
// GOOGLE_APPLICATION_CREDENTIALS (a service-account key file).

import { parseArgs } from "node:util";

import {
  Client,
  CloudAccount,
  Language,
  Realtime,
  RealtimeModel,
  Speaker,
  Voice,
  p,
  tool,
  type Agent,
  type Session,
} from "ulai-agents";

// checkBalance is what the agent can do. The handler's arguments are typed
// from the parameters.
const checkBalance = tool({
  name: "check_balance",
  description: "Look up the balance of an account.",
  parameters: {
    account: p.string("The account number."),
  },
  handler: async ({ account }) => ({ account, balance_rupees: 250 }),
});

// support is the agent: who it is, how it sounds, how it hears and speaks,
// and what it can do.
const support: Agent = {
  id: "support",
  instructions: "You are a bank's support agent. Be brief. Use check_balance when asked for a balance.",
  greeting: "Hello, how can I help you today?",
  closing: "Thanks for calling. Goodbye.",
  language: Language.EnglishIndia,
  voice: Voice.Kore,

  // One speech-to-speech model. For three separate stages instead:
  //   new Cascade({ llm: LLMModel.Gemini25Flash, stt: STTModel.Short, vad: VAD.Silero })
  pipeline: new Realtime({ model: RealtimeModel.GeminiLive25FlashNativeAudio }),

  tools: [checkBalance],
};

// handle is the agent's own logic for one call.
async function handle(session: Session): Promise<void> {
  console.log(`call ${session.id} from ${session.call.from}`);

  for await (const ev of session.events()) {
    switch (ev.type) {
      case "transcript":
        if (!ev.final) {
          continue;
        }
        console.log(`${ev.speaker}: ${ev.text}`);
        // Steer the model when the caller asks for something only you can
        // decide.
        if (ev.speaker === Speaker.Caller && ev.text.toLowerCase().includes("manager")) {
          try {
            await session.reply("Tell the caller a manager will call them back within an hour.");
          } catch (err) {
            console.error("reply:", err);
          }
        }
        break;
      case "rejected":
        console.log(`the server refused ${ev.command}: ${ev.message}`);
        break;
      case "ended":
        console.log(`call ended: ${ev.reason}, caller heard ${ev.heardMs}ms`);
        break;
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "join" }, // join: start a call in a room; serve: take calls as they arrive
      room: { type: "string", default: "" }, // join: the room
      "room-url": { type: "string", default: "" }, // join: the control plane holding the room
      "room-token": { type: "string", default: "" }, // join: the token for that control plane
    },
  });

  // Ctrl-C stops the call (join) or stops taking calls (serve).
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());

  // The server holds no model credentials: each agent brings its own.
  const cloud = await CloudAccount.fromFile(
    process.env.GOOGLE_CLOUD_PROJECT ?? "",
    "",
    process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  );
  const agent: Agent = { ...support, cloud };

  // Plaintext is allowed only to this machine. For a remote server, add
  // tls: true.
  const client = new Client(process.env.ULAI_ADDR || "127.0.0.1:50052", { apiKey: process.env.ULAI_API_KEY });
  try {
    switch (values.mode) {
      case "join":
        await client.run({ id: values.room, url: values["room-url"], token: values["room-token"] }, agent, handle, {
          signal: stop.signal,
        });
        break;
      case "serve":
        console.log(`waiting for calls to ${agent.id}`);
        await client.serve(agent.id, agent.tools, handle, { signal: stop.signal });
        break;
      default:
        throw new Error(`unknown --mode ${JSON.stringify(values.mode)}`);
    }
  } finally {
    client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

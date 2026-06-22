/**
 * Native AskUserQuestion E2E over the real gRPC stack (Phase F, default path).
 *
 * Proves the whole ask round-trip now that AskUserQuestion is the ONLY ask path
 * (the MCP ask_user tool was removed and canUseTool is wired by default): the
 * model calls AskUserQuestion → the canUseTool handler routes it through
 * ElicitationManager.askQuestionSet → an `ask` card event reaches the client →
 * the answer resolves the suspended turn → the turn completes reflecting the pick.
 *
 * Run: NOMOS_USE_SUBSCRIPTION=true DATABASE_URL=postgresql:///nomos \
 *        npx tsx eval/grpc-native-ask-e2e.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: join(homedir(), ".nomos", ".env"), quiet: true });
config({ path: ".env", quiet: true });
process.env.NOMOS_MEMORY_ENRICHMENT = "false";

import { AgentRuntime } from "../src/daemon/agent-runtime.ts";
import { ElicitationManager } from "../src/daemon/elicitation-manager.ts";
import { GrpcServer } from "../src/daemon/grpc-server.ts";
import { MessageQueue } from "../src/daemon/message-queue.ts";
import type { AgentEvent } from "../src/daemon/types.ts";
import { GrpcClient } from "../src/ui/grpc-client.ts";

const PORT = 18804;
const TURN_TIMEOUT = 180_000;

const results: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) =>
  results.push({ name, pass, detail });

async function main(): Promise<void> {
  const runtime = new AgentRuntime();
  await runtime.initialize();
  const mgr = new ElicitationManager({} as never); // terminal source → emitter path, no channelManager
  runtime.setElicitationManager(mgr);
  const queue = new MessageQueue((msg, emit) => runtime.processMessage(msg, emit));
  const server = new GrpcServer(queue, PORT);
  server.setElicitationManager(mgr);
  await server.start();
  const client = new GrpcClient({ port: PORT, autoReconnect: false });
  await client.connect();

  const chan = "ephemeral:e2e-native-ask";
  let askEvent: Extract<AgentEvent, { type: "ask" }> | undefined;
  let pickedLabel = "";

  try {
    const result = await new Promise<string>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("ask turn timed out"))),
        TURN_TIMEOUT,
      );
      const unsub = client.onEvent((ev: AgentEvent) => {
        if (ev.type === "ask" && !askEvent) {
          askEvent = ev;
          // Answer the FIRST question with its first option (out-of-band, like a client tap).
          const q = ev.questions?.[0] ?? { id: ev.id, options: ev.options };
          pickedLabel = q.options?.[0]?.label ?? "";
          if (q.id && pickedLabel) mgr.resolveById(q.id, pickedLabel);
        }
        if (ev.type === "result") finish(() => resolve(ev.result ?? ""));
        else if (ev.type === "error") finish(() => reject(new Error(ev.message)));
      });
      client.sendMessage(
        "Use the AskUserQuestion tool to ask me ONE quick multiple-choice question with exactly two options — 'Pick a color' with options Red and Blue. After I answer, reply with exactly: I'll use <my pick>.",
        chan,
      );
    });

    check("native ask: an `ask` card event reached the client", askEvent !== undefined);
    check(
      "native ask: the card carried questions[] (multi-question shape)",
      Array.isArray(askEvent?.questions) && (askEvent?.questions?.length ?? 0) >= 1,
      `questions=${askEvent?.questions?.length ?? 0}`,
    );
    check(
      "native ask: the turn completed reflecting the user's pick",
      pickedLabel.length > 0 && new RegExp(pickedLabel, "i").test(result),
      `picked=${pickedLabel} · result=${result.slice(0, 80)}`,
    );
  } finally {
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await server.stop();
    } catch {
      /* ignore */
    }
  }

  let ok = true;
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
    if (!r.pass) ok = false;
  }
  // eslint-disable-next-line no-console
  console.log(ok ? "\nNATIVE-ASK E2E OK" : "\nNATIVE-ASK E2E FAIL");
  process.exit(ok ? 0 : 1);
}

void main();

/**
 * Native team (Phase G step 2) E2E over the real gRPC stack.
 *
 * With team mode on (default) and NO NOMOS_LEGACY_TEAM, a `/team` request must be
 * handled by the NATIVE SDK `agents` path: the model delegates via the `Agent`
 * tool to parallel subagents that inherit this turn's permissions, then synthesizes
 * one reply — NOT via the hand-rolled TeamRuntime. Asserts (a) the turn completes
 * with a non-empty answer and (b) at least one `Agent` tool call was observed in
 * the stream (proof the model actually delegated to a native subagent).
 *
 * This is the eval that gates flipping team mode to native by default (plan G).
 *
 * Run: NOMOS_USE_SUBSCRIPTION=true DATABASE_URL=postgresql:///nomos \
 *        npx tsx eval/grpc-native-team-e2e.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: join(homedir(), ".nomos", ".env"), quiet: true });
config({ path: ".env", quiet: true });
process.env.NOMOS_MEMORY_ENRICHMENT = "false";
delete process.env.NOMOS_LEGACY_TEAM; // native path (the default)
delete process.env.NOMOS_TEAM_MODE; // team mode on (default)

import { AgentRuntime } from "../src/daemon/agent-runtime.ts";
import { GrpcServer } from "../src/daemon/grpc-server.ts";
import { MessageQueue } from "../src/daemon/message-queue.ts";
import type { AgentEvent } from "../src/daemon/types.ts";
import { GrpcClient } from "../src/ui/grpc-client.ts";

const PORT = 18803;
const TURN_TIMEOUT = 240_000;

const results: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) =>
  results.push({ name, pass, detail });

async function main(): Promise<void> {
  const runtime = new AgentRuntime();
  await runtime.initialize();
  const queue = new MessageQueue((msg, emit) => runtime.processMessage(msg, emit));
  const server = new GrpcServer(queue, PORT);
  await server.start();
  const client = new GrpcClient({ port: PORT, autoReconnect: false });
  await client.connect();

  const chan = "ephemeral:e2e-native-team";

  let agentToolUses = 0;
  let result = "";

  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("team turn timed out"))),
        TURN_TIMEOUT,
      );
      const unsub = client.onEvent((ev: AgentEvent) => {
        // The drain emits a tool_use_summary for every tool call, incl. the Agent tool.
        if (ev.type === "tool_use_summary" && /(^|_)Agent$/.test(ev.tool_name ?? "")) {
          agentToolUses++;
        }
        if (ev.type === "result") finish(() => resolve(((result = ev.result ?? ""), undefined)));
        else if (ev.type === "error") finish(() => reject(new Error(ev.message)));
      });
      client.sendMessage(
        "/team Use the Agent tool to spawn TWO team-worker subagents in parallel: one that lists three arguments FOR remote work, one that lists three arguments AGAINST. Then synthesize both into a short balanced summary.",
        chan,
      );
    });

    check(
      "native team: the /team turn completed with a non-empty answer",
      result.trim().length > 0,
      result.slice(0, 120),
    );
    check(
      "native team: the model delegated via the Agent tool (>=1 subagent call)",
      agentToolUses >= 1,
      `agentToolUses=${agentToolUses}`,
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
  console.log(ok ? "\nNATIVE-TEAM E2E OK" : "\nNATIVE-TEAM E2E FAIL");
  process.exit(ok ? 0 : 1);
}

void main();

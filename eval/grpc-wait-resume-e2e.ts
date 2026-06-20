/**
 * Multi-conversation wait-and-resume E2E over the real gRPC stack.
 *
 * Boots the actual daemon runtime (AgentRuntime + MessageQueue + GrpcServer) and
 * drives TWO independent conversations over the NomosAgent.Chat RPC. Each kicks
 * off background work; we then run the watcher (as the __background_watch__ cron
 * does) and assert each conversation is RESUMED on its OWN session with its OWN
 * result — no dead-end, no silent drop, no cross-talk. This verifies the shipped
 * Layer-B bridge end-to-end through the real interface, not just unit-level.
 *
 * Run: NOMOS_USE_SUBSCRIPTION=true DATABASE_URL=postgresql:///nomos npx tsx eval/grpc-wait-resume-e2e.ts
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: join(homedir(), ".nomos", ".env"), quiet: true });
config({ path: ".env", quiet: true });
process.env.NOMOS_MEMORY_ENRICHMENT = "false"; // keep the E2E focused + fast

import { AgentRuntime } from "../src/daemon/agent-runtime.ts";
import {
  buildResumePrompt,
  getBackgroundTaskStore,
  InProcessBackgroundTaskStore,
  runBackgroundWatchSweep,
  setBackgroundTaskStore,
} from "../src/daemon/background-tasks.ts";
import { GrpcServer } from "../src/daemon/grpc-server.ts";
import { MessageQueue } from "../src/daemon/message-queue.ts";
import type { AgentEvent } from "../src/daemon/types.ts";
import { GrpcClient } from "../src/ui/grpc-client.ts";

const PORT = 18799;
const TURN_TIMEOUT = 150_000;

function sendAndWait(
  client: GrpcClient,
  content: string,
  sessionKey: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("chat turn timed out"))),
      timeoutMs,
    );
    const unsub = client.onEvent((ev: AgentEvent) => {
      if (ev.type === "result") finish(() => resolve(ev.result ?? ""));
      else if (ev.type === "error") finish(() => reject(new Error(ev.message)));
    });
    client.sendMessage(content, sessionKey);
  });
}

const results: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) =>
  results.push({ name, pass, detail });

async function main(): Promise<void> {
  // Use the real default substrate when configured (Redis if REDIS_URL is set;
  // disk for power-user), else a deterministic in-memory store so the E2E runs
  // anywhere. With REDIS_URL set, this exercises the hosted substrate end-to-end.
  if (!process.env.REDIS_URL) setBackgroundTaskStore(new InProcessBackgroundTaskStore());
  const runtime = new AgentRuntime();
  await runtime.initialize();
  const queue = new MessageQueue((msg, emit) => runtime.processMessage(msg, emit));
  const server = new GrpcServer(queue, PORT);
  await server.start();
  const client = new GrpcClient({ port: PORT, autoReconnect: false });
  await client.connect();

  const chanA = "ephemeral:e2e-bgA";
  const chanB = "ephemeral:e2e-bgB";

  try {
    // Two independent conversations over gRPC, each kicking off background work.
    await sendAndWait(
      client,
      "I'm shipping PR-A. I've kicked off its CI run in the background and I'm waiting on it — just acknowledge in one short sentence.",
      chanA,
      TURN_TIMEOUT,
    );
    await sendAndWait(
      client,
      "I'm shipping PR-B. I've kicked off its CI run in the background and I'm waiting on it — just acknowledge in one short sentence.",
      chanB,
      TURN_TIMEOUT,
    );

    // Register one background task per conversation (deterministic stand-in for the
    // agent's `background_register` tool call), each watching a fast-settling command.
    const store = getBackgroundTaskStore();
    await store.register({
      sessionKey: `terminal:${chanA}`,
      platform: "terminal",
      channelId: chanA,
      userId: "local",
      kind: "ci",
      summary: "CI for PR-A",
      watch: "echo 'CI for PR-A finished: SUCCESS, all checks green'",
    });
    await store.register({
      sessionKey: `terminal:${chanB}`,
      platform: "terminal",
      channelId: chanB,
      userId: "local",
      kind: "ci",
      summary: "CI for PR-B",
      watch: "echo 'CI for PR-B finished: FAILED, 2 tests broke'",
    });

    // Run the watcher exactly as the cron sentinel does: on settle, resume the
    // ORIGINAL session with the result through the real runtime queue.
    const resumeAnswer: Record<string, string> = {};
    const sweep = await runBackgroundWatchSweep(async (task) => {
      const incoming = {
        id: randomUUID(),
        platform: task.platform,
        channelId: task.channelId,
        userId: task.userId,
        content: buildResumePrompt(task),
        timestamp: new Date(),
        metadata: { source: "background-resume", backgroundTaskId: task.id },
      };
      const out = await queue.enqueue(task.sessionKey, incoming, () => {});
      resumeAnswer[task.channelId] = out.content;
    });

    check("watcher settled both background tasks", sweep.settled === 2, JSON.stringify(sweep));

    const a = resumeAnswer[chanA] ?? "";
    const b = resumeAnswer[chanB] ?? "";
    check("conversation A was resumed (non-empty follow-up turn)", a.length > 0, a.slice(0, 80));
    check("conversation B was resumed (non-empty follow-up turn)", b.length > 0, b.slice(0, 80));
    check(
      "A's resume reflects A's result (CI success)",
      /success|green|pass/i.test(a),
      a.slice(0, 120),
    );
    check(
      "B's resume reflects B's result (CI failure)",
      /fail|broke|red/i.test(b),
      b.slice(0, 120),
    );
    check("no cross-talk: A does not mention PR-B", !/pr-b/i.test(a), a.slice(0, 120));
    check("no cross-talk: B does not mention PR-A", !/pr-a/i.test(b), b.slice(0, 120));
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
  console.log(ok ? "\nE2E OK" : "\nE2E FAIL");
  process.exit(ok ? 0 : 1);
}

void main();

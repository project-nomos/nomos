/**
 * Layer-A (held-open streaming session) E2E over the real gRPC stack.
 *
 * With NOMOS_LIVE_SESSIONS=true a session is HELD OPEN: the initial turn AND the
 * background-task resume run through the SAME live streaming session — in-context,
 * zero-warmup. Asserts (a) the resume reflects the CI result (the live path emits
 * correct output) and (b) the LiveSessionManager processed >=2 turns on that one
 * session (deterministic proof the resume rode the held-open session, not a cold
 * re-spawn). The one-shot path is covered by grpc-wait-resume-e2e.ts.
 *
 * Run: NOMOS_LIVE_SESSIONS=true NOMOS_USE_SUBSCRIPTION=true DATABASE_URL=postgresql:///nomos \
 *        npx tsx eval/grpc-live-session-e2e.ts
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: join(homedir(), ".nomos", ".env"), quiet: true });
config({ path: ".env", quiet: true });
process.env.NOMOS_LIVE_SESSIONS = "true"; // Layer A on
process.env.NOMOS_MEMORY_ENRICHMENT = "false";

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

const PORT = 18801;
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
  setBackgroundTaskStore(new InProcessBackgroundTaskStore());
  const runtime = new AgentRuntime();
  await runtime.initialize();
  const queue = new MessageQueue((msg, emit) => runtime.processMessage(msg, emit));
  const server = new GrpcServer(queue, PORT);
  await server.start();
  const client = new GrpcClient({ port: PORT, autoReconnect: false });
  await client.connect();

  const chan = "ephemeral:e2e-live";
  const sessionKey = `terminal:${chan}`;

  try {
    // Turn 1 over gRPC — opens the held-open live session.
    await sendAndWait(
      client,
      "I'm shipping PR-A. I've kicked off its CI in the background and I'm waiting on it. Acknowledge in one short sentence.",
      chan,
      TURN_TIMEOUT,
    );

    check(
      "Layer A: a live session opened for the conversation (1 turn so far)",
      runtime.liveSessionTurns(sessionKey) === 1,
      `turns=${runtime.liveSessionTurns(sessionKey)}`,
    );

    // Background work settles; the watcher resumes the SAME session.
    const store = getBackgroundTaskStore();
    await store.register({
      sessionKey,
      platform: "terminal",
      channelId: chan,
      userId: "local",
      kind: "ci",
      summary: "CI run",
      watch: "echo 'CI finished: SUCCESS, all checks green'",
    });

    let resume = "";
    await runBackgroundWatchSweep(async (task) => {
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
      resume = out.content;
    });

    check(
      "resume reflects the CI result (success)",
      /success|green|pass/i.test(resume),
      resume.slice(0, 120),
    );
    check(
      "Layer A: the held-open session processed BOTH the turn and the resume in-process",
      runtime.liveSessionTurns(sessionKey) >= 2,
      `turns=${runtime.liveSessionTurns(sessionKey)}`,
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
  console.log(ok ? "\nLAYER-A E2E OK" : "\nLAYER-A E2E FAIL");
  process.exit(ok ? 0 : 1);
}

void main();

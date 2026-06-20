/**
 * Phase-0 streaming spike (wait-and-resume Layer A go/no-go).
 *
 * Verifies, against the REAL installed SDK, that an AsyncIterable<SDKUserMessage>
 * prompt opens a LIVE session we can inject into mid-stream: the generator stays
 * alive past the first turn and a message pushed after the first reply produces a
 * SECOND turn. That "inject into a live loop" property is the substrate for
 * resuming a session when background work (CI) settles. Run:
 *   NOMOS_USE_SUBSCRIPTION=true npx tsx eval/streaming-spike.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: join(homedir(), ".nomos", ".env"), quiet: true });
config({ path: ".env", quiet: true });

import { runSession, type SDKMessage, type SDKUserMessage } from "../src/sdk/session.ts";

function userMsg(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

/** A host-owned prompt channel: push messages into a live streaming session. */
class PromptChannel implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private done = false;

  push(text: string): void {
    const m = userMsg(text);
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.buf.push(m);
  }
  end(): void {
    this.done = true;
    const w = this.waiters.shift();
    if (w) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

function assistantText(m: Record<string, unknown>): string {
  const content = (m.message as { content?: Array<Record<string, unknown>> })?.content ?? [];
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

async function main(): Promise<void> {
  const ch = new PromptChannel();
  ch.push("Reply with exactly the single word READY and nothing else.");

  const q = await runSession({
    prompt: ch,
    model: "claude-haiku-4-5",
    useSubscription: process.env.NOMOS_USE_SUBSCRIPTION === "true",
    maxTurns: 20,
    allowedTools: [],
    permissionMode: "bypassPermissions",
  });

  const texts: string[] = [];
  let results = 0;
  let idles = 0;
  let pushedSecond = false;
  let reengaged = false;
  const start = Date.now();

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    const m = msg as unknown as Record<string, unknown>;
    if (m.type === "assistant") {
      const t = assistantText(m);
      if (t) texts.push(t);
    }
    if (m.type === "system" && m.subtype === "session_state_changed" && m.state === "idle") idles++;
    if (m.type === "result") results++;

    if (!pushedSecond && texts.some((t) => /READY/i.test(t))) {
      pushedSecond = true; // inject a SECOND message into the still-live session
      ch.push("Now reply with exactly the single word DONE and nothing else.");
    }
    if (pushedSecond && texts.some((t) => /DONE/i.test(t))) {
      reengaged = true;
      ch.end();
      break;
    }
    if (Date.now() - start > 90_000) {
      ch.end();
      break;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    "SPIKE " +
      JSON.stringify({
        reengaged, // <- the key result: live-session injection produced a 2nd turn
        results,
        idles,
        turns: texts.length,
        texts: texts.slice(0, 4),
      }),
  );
  process.exit(reengaged ? 0 : 1);
}

void main();

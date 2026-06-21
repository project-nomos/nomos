/**
 * §1.2 harness — does the SDK invoke `Options.canUseTool` for the native
 * `AskUserQuestion` tool when `permissionMode: "bypassPermissions"`?
 *
 * This is the single gate for Phase F of the SDK-adoption plan. Native
 * AskUserQuestion is delivered ONLY through `canUseTool`; the docs confirm it
 * fires in `default`/`plan` but are silent on `bypassPermissions` (which the
 * daemon uses). The `.d.ts` can't settle it (the emit decision is in the
 * compiled binary), so we observe a real turn.
 *
 * PASS (fired=true) → Phase F can adopt native AskUserQuestion via canUseTool.
 * FAIL (fired=false) → keep the daemon on the MCP `ask_user` path, OR switch the
 * daemon to permissionMode:"default" + the block_critical deny hook for F.
 *
 * Run:  NOMOS_USE_SUBSCRIPTION=true npx tsx eval/canusetool-bypass-harness.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: join(homedir(), ".nomos", ".env"), quiet: true });
config({ path: ".env", quiet: true });

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

async function main(): Promise<void> {
  const useSubscription = process.env.NOMOS_USE_SUBSCRIPTION === "true";

  // Mirror session.ts's subprocess env handling.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  if (useSubscription) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
  }

  let fired = false;
  let firedInput: unknown;

  const q = query({
    prompt:
      "Before doing anything else, you MUST call the AskUserQuestion tool to ask me ONE " +
      "multiple-choice clarifying question (2 options). Call AskUserQuestion now. Do not answer in prose first.",
    options: {
      model: "claude-haiku-4-5",
      permissionMode: "bypassPermissions",
      allowedTools: ["AskUserQuestion"],
      maxTurns: 3,
      env,
      // The probe: record whether the SDK routes AskUserQuestion through here.
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === "AskUserQuestion") {
          fired = true;
          firedInput = input;
          // Synthesize an answer so the turn can complete cleanly.
          const questions = (input.questions as Array<Record<string, unknown>>) ?? [];
          const answers: Record<string, string> = {};
          for (const qq of questions) {
            const opts = (qq.options as Array<{ label?: string }>) ?? [];
            answers[String(qq.question ?? "")] = opts[0]?.label ?? "ok";
          }
          return { behavior: "allow", updatedInput: { ...input, answers } };
        }
        return { behavior: "allow", updatedInput: input };
      },
    },
  });

  const start = Date.now();
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    const m = msg as unknown as Record<string, unknown>;
    if (m.type === "result") break;
    if (fired) break; // got what we needed
    if (Date.now() - start > 90_000) break;
  }

  const questionCount = Array.isArray((firedInput as { questions?: unknown[] })?.questions)
    ? (firedInput as { questions: unknown[] }).questions.length
    : 0;

  // eslint-disable-next-line no-console
  console.log(
    "CANUSETOOL " +
      JSON.stringify({
        fired, // <- the gate: did canUseTool fire for AskUserQuestion under bypassPermissions?
        permissionMode: "bypassPermissions",
        questionCount,
      }),
  );
  process.exit(fired ? 0 : 1);
}

void main();

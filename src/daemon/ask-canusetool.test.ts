import { describe, it, expect, vi } from "vitest";
import { buildAskCanUseTool } from "./agent-runtime.ts";
import type { ElicitationManager, ElicitationSource } from "./elicitation-manager.ts";

const source = { platform: "terminal", channelId: "c1" } as unknown as ElicitationSource;
const sig = new AbortController().signal;

describe("buildAskCanUseTool (Phase F — native AskUserQuestion → multi-question card)", () => {
  it("asks all questions as ONE set and maps the answers by question text", async () => {
    // askQuestionSet returns the chosen label per question, aligned to input order.
    const askQuestionSet = vi.fn().mockResolvedValue(["Ship it", "Postgres"]);
    const mgr = { askQuestionSet } as unknown as ElicitationManager;

    const canUseTool = buildAskCanUseTool(mgr, source);
    const result = await canUseTool(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Ship now or wait?",
            header: "Timing",
            options: [{ label: "Ship it" }, { label: "Wait" }],
          },
          { question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
        ],
      },
      { signal: sig } as never,
    );

    expect(askQuestionSet).toHaveBeenCalledTimes(1); // ONE card, not N sequential
    const passedQuestions = askQuestionSet.mock.calls[0][0];
    expect(passedQuestions).toHaveLength(2);
    expect(passedQuestions[0].header).toBe("Timing");

    const updated = (result as unknown as { updatedInput: { answers: Record<string, string> } })
      .updatedInput;
    expect(updated.answers["Ship now or wait?"]).toBe("Ship it");
    expect(updated.answers["Which DB?"]).toBe("Postgres");
  });

  it("passes non-AskUserQuestion tools straight through (allow)", async () => {
    const mgr = { askQuestionSet: vi.fn() } as unknown as ElicitationManager;
    const canUseTool = buildAskCanUseTool(mgr, source);
    const result = await canUseTool("Bash", { command: "ls" }, { signal: sig } as never);
    expect(result.behavior).toBe("allow");
    expect(mgr.askQuestionSet as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("omits an answer when a question is declined (empty string from the set)", async () => {
    const mgr = {
      askQuestionSet: vi.fn().mockResolvedValue([""]),
    } as unknown as ElicitationManager;
    const canUseTool = buildAskCanUseTool(mgr, source);
    const result = await canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
      { signal: sig } as never,
    );
    const updated = (result as unknown as { updatedInput: { answers: Record<string, string> } })
      .updatedInput;
    expect(updated.answers["Q?"]).toBeUndefined();
  });
});

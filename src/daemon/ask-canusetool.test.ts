import { describe, it, expect, vi } from "vitest";
import { buildAskCanUseTool } from "./agent-runtime.ts";
import type { ElicitationManager, ElicitationSource } from "./elicitation-manager.ts";

const source = { platform: "terminal", channelId: "c1" } as unknown as ElicitationSource;
const sig = new AbortController().signal;

describe("buildAskCanUseTool (Phase F — native AskUserQuestion → elicitation card)", () => {
  it("routes each AskUserQuestion through handleElicitation and maps the answers", async () => {
    const handleElicitation = vi
      .fn()
      .mockResolvedValueOnce({ action: "accept", content: { answer: "Ship it" } })
      .mockResolvedValueOnce({ action: "accept", content: { answer: "Postgres" } });
    const mgr = { handleElicitation } as unknown as ElicitationManager;

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

    expect(handleElicitation).toHaveBeenCalledTimes(2);
    expect(result.behavior).toBe("allow");
    const updated = (result as unknown as { updatedInput: { answers: Record<string, string> } })
      .updatedInput;
    expect(updated.answers["Ship now or wait?"]).toBe("Ship it");
    expect(updated.answers["Which DB?"]).toBe("Postgres");
    // The header is prepended to the rendered message.
    expect(handleElicitation.mock.calls[0][0].message).toBe("Timing: Ship now or wait?");
  });

  it("passes non-AskUserQuestion tools straight through (allow)", async () => {
    const mgr = { handleElicitation: vi.fn() } as unknown as ElicitationManager;
    const canUseTool = buildAskCanUseTool(mgr, source);
    const result = await canUseTool("Bash", { command: "ls" }, { signal: sig } as never);
    expect(result.behavior).toBe("allow");
    expect(mgr.handleElicitation as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("omits an answer when the user declines (no synthetic answer)", async () => {
    const mgr = {
      handleElicitation: vi.fn().mockResolvedValue({ action: "decline" }),
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

import { describe, it, expect } from "vitest";
import { ElicitationManager, type ElicitationSource } from "./elicitation-manager.ts";
import type { AgentEvent } from "./types.ts";

const source: ElicitationSource = { platform: "terminal", channelId: "c1" };
type AskEvent = Extract<AgentEvent, { type: "ask" }>;

describe("ElicitationManager.askQuestionSet (Phase F multi-question card)", () => {
  it("emits ONE ask event carrying questions[] and resolves once all are answered", async () => {
    const mgr = new ElicitationManager({} as never);
    let asked: AskEvent | undefined;
    mgr.registerEmitter(source, (e) => {
      if (e.type === "ask") asked = e;
    });

    const ac = new AbortController();
    const promise = mgr.askQuestionSet(
      [
        {
          prompt: "Ship now or wait?",
          header: "Timing",
          options: [{ label: "Ship it" }, { label: "Wait" }],
        },
        { prompt: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      ],
      source,
      ac.signal,
    );

    // One combined card, both questions, each with its own id + header preserved.
    expect(asked).toBeDefined();
    expect(asked!.questions).toHaveLength(2);
    expect(asked!.questions![0]!.header).toBe("Timing");
    // questions[].prompt is CLEAN (header rides alongside as the eyebrow); prepending
    // it here too would double-render as "Timing: Timing: …" on the card.
    expect(asked!.questions![0]!.prompt).toBe("Ship now or wait?");
    // Top-level prompt keeps the header prepend for single-question clients that
    // don't render the eyebrow separately.
    expect(asked!.prompt).toBe("Timing: Ship now or wait?");
    expect(asked!.id).toBe(asked!.questions![0]!.id);

    // Answer each via the existing per-question RPC; the set resolves when both land.
    expect(mgr.resolveById(asked!.questions![0]!.id, "Ship it")).toBe(true);
    expect(mgr.resolveById(asked!.questions![1]!.id, "Postgres")).toBe(true);

    expect(await promise).toEqual(["Ship it", "Postgres"]);
    expect(mgr.pendingCount()).toBe(0);
  });

  it("returns '' for a question that is aborted before it is answered", async () => {
    const mgr = new ElicitationManager({} as never);
    mgr.registerEmitter(source, () => {});
    const ac = new AbortController();
    const promise = mgr.askQuestionSet(
      [{ prompt: "Q?", options: [{ label: "A" }, { label: "B" }] }],
      source,
      ac.signal,
    );
    ac.abort();
    expect(await promise).toEqual([""]);
  });
});

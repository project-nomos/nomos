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

describe("ElicitationManager renderQuestion (Slack adapter path)", () => {
  const slackSource: ElicitationSource = { platform: "slack", channelId: "C-DEFAULT" };

  // Fake Slack adapter whose postBlocks/send read `this`, reproducing the binding
  // requirement that the detached (unbound) call broke at runtime.
  function fakeSlackAdapter(defaultChannelId: string) {
    return {
      defaultChannelId,
      postBlocksCalls: [] as Array<{ channelId: string }>,
      sendCalls: [] as Array<{ channelId: string; content: string }>,
      async postBlocks(channelId: string, _text: string, _blocks: unknown[], _threadId?: string) {
        // Reading `this.defaultChannelId` throws if `this` is undefined — i.e. if
        // postBlocks was called detached/unbound (the v0.1.59 regression).
        if (channelId !== this.defaultChannelId) return undefined;
        this.postBlocksCalls.push({ channelId });
        return "posted-ts-1";
      },
      async send(msg: { channelId: string; content: string }) {
        this.sendCalls.push({ channelId: msg.channelId, content: msg.content });
      },
    };
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("renders via the adapter's BOUND postBlocks (regression: no unbound-`this` crash)", async () => {
    const adapter = fakeSlackAdapter("C-DEFAULT");
    const mgr = new ElicitationManager({ getAdapter: () => adapter } as never);
    const ac = new AbortController();
    const promise = mgr.askQuestionSet(
      [{ prompt: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }],
      slackSource,
      ac.signal,
    );
    await flush();
    // With the bug (detached call) `this.defaultChannelId` throws → "render failed"
    // and the call never lands. Bound, it records exactly one post on the default channel.
    expect(adapter.postBlocksCalls).toEqual([{ channelId: "C-DEFAULT" }]);
    ac.abort();
    expect(await promise).toEqual([""]);
  });

  it("falls back to a text message when postBlocks declines (non-default channel)", async () => {
    const adapter = fakeSlackAdapter("C-DEFAULT");
    const mgr = new ElicitationManager({ getAdapter: () => adapter } as never);
    const ac = new AbortController();
    const promise = mgr.askQuestionSet(
      [{ prompt: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }],
      { platform: "slack", channelId: "C-OTHER" }, // not the watched default channel
      ac.signal,
    );
    await flush();
    expect(adapter.postBlocksCalls).toEqual([]); // declined → undefined
    expect(adapter.sendCalls).toHaveLength(1); // so the question still renders as text
    expect(adapter.sendCalls[0]!.channelId).toBe("C-OTHER");
    ac.abort();
    expect(await promise).toEqual([""]);
  });
});

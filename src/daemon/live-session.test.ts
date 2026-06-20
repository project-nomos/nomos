import { describe, expect, it, vi } from "vitest";

// Fake the SDK: each user message pushed into the prompt channel yields one
// assistant text + one result, so we can drive the manager deterministically
// without an LLM.
vi.mock("../sdk/session.ts", () => ({
  runSession: (params: { prompt: AsyncIterable<{ message: { content: string } }> }) =>
    (async function* () {
      for await (const userMsg of params.prompt) {
        const text = `echo:${userMsg.message.content}`;
        yield { type: "assistant", message: { content: [{ type: "text", text }] } };
        yield {
          type: "result",
          session_id: "sess-1",
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
          result: text,
        };
      }
    })(),
}));

import { LiveSessionManager, type LiveTurnState, type SdkMessageHandler } from "./live-session.ts";

// A minimal handler mirroring AgentRuntime.handleSdkMessage: accumulate assistant
// text; turn-over on `result`.
const handle: SdkMessageHandler = (msg, _emit, state) => {
  const m = msg as unknown as Record<string, unknown>;
  if (m.type === "assistant") {
    const blocks = (m.message as { content: { type: string; text: string }[] }).content;
    for (const b of blocks) if (b.type === "text") state.fullText += b.text;
    return false;
  }
  if (m.type === "result") {
    state.sessionId = m.session_id as string;
    return true;
  }
  return false;
};

const noopEmit = () => {};
const params = (prompt: string) =>
  ({ prompt }) as unknown as Parameters<LiveSessionManager["runTurn"]>[1];

describe("LiveSessionManager (held-open streaming sessions)", () => {
  it("opens a session and resolves a turn with the accumulated result", async () => {
    const mgr = new LiveSessionManager(handle);
    const st: LiveTurnState = await mgr.runTurn("s1", params("hello"), noopEmit);
    expect(st.fullText).toBe("echo:hello");
    expect(st.sessionId).toBe("sess-1");
    expect(mgr.hasLive("s1")).toBe(true);
    expect(mgr.turnCount("s1")).toBe(1);
    mgr.closeAll();
  });

  it("REUSES the same live session across turns (the Layer-A property)", async () => {
    const mgr = new LiveSessionManager(handle);
    await mgr.runTurn("s1", params("one"), noopEmit);
    const second = await mgr.runTurn("s1", params("two"), noopEmit);
    expect(second.fullText).toBe("echo:two"); // fresh per-turn accumulator
    expect(mgr.turnCount("s1")).toBe(2); // both turns rode ONE held-open session
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("keeps sessions isolated by key", async () => {
    const mgr = new LiveSessionManager(handle);
    await mgr.runTurn("a", params("x"), noopEmit);
    await mgr.runTurn("b", params("y"), noopEmit);
    expect(mgr.turnCount("a")).toBe(1);
    expect(mgr.turnCount("b")).toBe(1);
    expect(mgr.size).toBe(2);
    mgr.closeAll();
  });

  it("evicts the oldest session past the cap", async () => {
    const mgr = new LiveSessionManager(handle, { maxSessions: 2 });
    await mgr.runTurn("a", params("x"), noopEmit);
    await mgr.runTurn("b", params("y"), noopEmit);
    await mgr.runTurn("c", params("z"), noopEmit); // evicts "a"
    expect(mgr.size).toBe(2);
    expect(mgr.hasLive("a")).toBe(false);
    expect(mgr.hasLive("c")).toBe(true);
    mgr.closeAll();
  });
});

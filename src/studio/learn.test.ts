import { beforeEach, describe, expect, it, vi } from "vitest";

const { runReasoningFork } = vi.hoisted(() => ({ runReasoningFork: vi.fn() }));
const { vaultRead, vaultWrite } = vi.hoisted(() => ({ vaultRead: vi.fn(), vaultWrite: vi.fn() }));
const { upsertUserModel } = vi.hoisted(() => ({ upsertUserModel: vi.fn() }));
const { loadEnvConfig } = vi.hoisted(() => ({ loadEnvConfig: vi.fn() }));

vi.mock("../sdk/reasoning-fork.ts", () => ({ runReasoningFork }));
vi.mock("../memory/vault.ts", () => ({ vaultRead, vaultWrite }));
vi.mock("../db/user-model.ts", () => ({ upsertUserModel }));
vi.mock("../config/env.ts", () => ({ loadEnvConfig }));

import { flushPhotoStyle, readPhotoStyle, recordEditSignal } from "./learn.ts";

// runReasoningFork now owns parsing/validation (SDK structured output + one balanced-JSON
// fallback), so these tests mock its {data, raw} contract directly: `data` is the
// already-validated DistilledStyle (or null on parse failure), `raw` carries text for logging.
function fork(data: unknown, text = "") {
  return { data, raw: { text } };
}

describe("flushPhotoStyle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadEnvConfig.mockReturnValue({ adaptiveMemory: true });
    vaultRead.mockResolvedValue(null);
  });

  it("distills the batch into the vault note + photo_style user_model entries", async () => {
    runReasoningFork.mockResolvedValue(
      fork({ profile: "Warm and punchy.", prefs: { tone: "warm", color: "punchy" } }),
    );
    await flushPhotoStyle("u1", [{ op: "editSemantic", instruction: "warm it up" }]);

    expect(vaultWrite).toHaveBeenCalledWith(
      "u1",
      "photo-style.md",
      "Warm and punchy.",
      expect.anything(),
    );
    expect(upsertUserModel).toHaveBeenCalledWith(
      expect.objectContaining({ category: "photo_style", key: "tone", value: "warm" }),
    );
    expect(upsertUserModel).toHaveBeenCalledWith(
      expect.objectContaining({ category: "photo_style", key: "color", value: "punchy" }),
    );
  });

  it("passes the stable rubric as instructions and only dynamic data as input", async () => {
    vaultRead.mockResolvedValue({ content: "existing profile" });
    runReasoningFork.mockResolvedValue(fork({ profile: "p", prefs: {} }));
    await flushPhotoStyle("u1", [{ op: "editSemantic", instruction: "warm it up" }]);

    const call = runReasoningFork.mock.calls[0][0];
    // Rubric is cached (stable) — no per-flush data leaks into it.
    expect(call.instructions).toContain("PHOTO-EDITING taste");
    expect(call.instructions).not.toContain("existing profile");
    expect(call.instructions).not.toContain("warm it up");
    // Dynamic data goes in the (uncached) input, sent last.
    expect(call.input).toContain("existing profile");
    expect(call.input).toContain("warm it up");
  });

  it("no-ops on an empty batch or an unparseable distillation", async () => {
    await flushPhotoStyle("u1", []);
    expect(runReasoningFork).not.toHaveBeenCalled();

    // Parse/validation failure → runReasoningFork returns data: null → skip the write.
    runReasoningFork.mockResolvedValue(fork(null, "i couldn't"));
    await flushPhotoStyle("u1", [{ op: "editSemantic", instruction: "x" }]);
    expect(vaultWrite).not.toHaveBeenCalled();
  });
});

describe("recordEditSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultRead.mockResolvedValue(null);
    runReasoningFork.mockResolvedValue(fork({ profile: "p", prefs: {} }));
  });

  it("never learns when adaptive memory is off", async () => {
    loadEnvConfig.mockReturnValue({ adaptiveMemory: false });
    for (let i = 0; i < 6; i++) await recordEditSignal("off-user", "editSemantic", `edit ${i}`);
    expect(runReasoningFork).not.toHaveBeenCalled();
  });

  it("distills once it has buffered the threshold of edits", async () => {
    loadEnvConfig.mockReturnValue({ adaptiveMemory: true });
    for (let i = 0; i < 4; i++) await recordEditSignal("on-user", "editSemantic", `edit ${i}`);
    expect(runReasoningFork).toHaveBeenCalledTimes(1);
    expect(vaultWrite).toHaveBeenCalledTimes(1);
  });
});

describe("readPhotoStyle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the note content when enabled, '' when disabled", async () => {
    loadEnvConfig.mockReturnValue({ adaptiveMemory: true });
    vaultRead.mockResolvedValue({ content: "  Warm, soft skin.  " });
    expect(await readPhotoStyle("u9")).toBe("Warm, soft skin.");

    loadEnvConfig.mockReturnValue({ adaptiveMemory: false });
    expect(await readPhotoStyle("u9")).toBe("");
  });
});

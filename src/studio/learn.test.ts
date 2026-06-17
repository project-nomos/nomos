import { beforeEach, describe, expect, it, vi } from "vitest";

const { runForkedAgent } = vi.hoisted(() => ({ runForkedAgent: vi.fn() }));
const { vaultRead, vaultWrite } = vi.hoisted(() => ({ vaultRead: vi.fn(), vaultWrite: vi.fn() }));
const { upsertUserModel } = vi.hoisted(() => ({ upsertUserModel: vi.fn() }));
const { loadEnvConfig } = vi.hoisted(() => ({ loadEnvConfig: vi.fn() }));

vi.mock("../sdk/forked-agent.ts", () => ({ runForkedAgent }));
vi.mock("../memory/vault.ts", () => ({ vaultRead, vaultWrite }));
vi.mock("../db/user-model.ts", () => ({ upsertUserModel }));
vi.mock("../config/env.ts", () => ({ loadEnvConfig }));

import { flushPhotoStyle, parseStyle, readPhotoStyle, recordEditSignal } from "./learn.ts";

describe("parseStyle", () => {
  it("parses the profile + prefs", () => {
    const s = parseStyle('{"profile":"Warm, soft skin.","prefs":{"tone":"warm","skin":"smooth"}}');
    expect(s?.profile).toBe("Warm, soft skin.");
    expect(s?.prefs.tone).toBe("warm");
    expect(s?.prefs.skin).toBe("smooth");
  });

  it("strips code fences", () => {
    expect(parseStyle('```json\n{"profile":"x"}\n```')?.profile).toBe("x");
  });

  it("recovers JSON wrapped in prose", () => {
    expect(parseStyle('Here is the profile:\n{"profile":"warm"}\nThanks!')?.profile).toBe("warm");
  });

  it("recovers the first object when the model emits the fenced block twice", () => {
    // Real Haiku failure mode: the same fenced object repeated back-to-back.
    const dup =
      '```json\n{"profile":"warm","prefs":{"tone":"warm"}}\n``````json\n{"profile":"warm"}\n```';
    const s = parseStyle(dup);
    expect(s?.profile).toBe("warm");
    expect(s?.prefs.tone).toBe("warm");
  });

  it("ignores braces inside string values when balancing", () => {
    expect(parseStyle('{"profile":"a {nested} brace","prefs":{}}')?.profile).toBe(
      "a {nested} brace",
    );
  });

  it("returns null without a usable profile", () => {
    expect(parseStyle('{"prefs":{}}')).toBeNull();
    expect(parseStyle("sorry, not JSON")).toBeNull();
  });
});

describe("flushPhotoStyle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadEnvConfig.mockReturnValue({ adaptiveMemory: true });
    vaultRead.mockResolvedValue(null);
  });

  it("distills the batch into the vault note + photo_style user_model entries", async () => {
    runForkedAgent.mockResolvedValue({
      text: '{"profile":"Warm and punchy.","prefs":{"tone":"warm","color":"punchy"}}',
    });
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

  it("no-ops on an empty batch or an unparseable distillation", async () => {
    await flushPhotoStyle("u1", []);
    expect(runForkedAgent).not.toHaveBeenCalled();

    runForkedAgent.mockResolvedValue({ text: "i couldn't" });
    await flushPhotoStyle("u1", [{ op: "editSemantic", instruction: "x" }]);
    expect(vaultWrite).not.toHaveBeenCalled();
  });
});

describe("recordEditSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultRead.mockResolvedValue(null);
    runForkedAgent.mockResolvedValue({ text: '{"profile":"p","prefs":{}}' });
  });

  it("never learns when adaptive memory is off", async () => {
    loadEnvConfig.mockReturnValue({ adaptiveMemory: false });
    for (let i = 0; i < 6; i++) await recordEditSignal("off-user", "editSemantic", `edit ${i}`);
    expect(runForkedAgent).not.toHaveBeenCalled();
  });

  it("distills once it has buffered the threshold of edits", async () => {
    loadEnvConfig.mockReturnValue({ adaptiveMemory: true });
    for (let i = 0; i < 4; i++) await recordEditSignal("on-user", "editSemantic", `edit ${i}`);
    expect(runForkedAgent).toHaveBeenCalledTimes(1);
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

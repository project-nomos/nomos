import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceBridgeRegistry, type DeviceInvocation } from "./device-bridge.ts";

describe("DeviceBridgeRegistry", () => {
  let reg: DeviceBridgeRegistry;

  beforeEach(() => {
    reg = new DeviceBridgeRegistry();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails cleanly when no device is connected", async () => {
    const r = await reg.invoke("u1", "calendar_list_events", "{}");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No device connected/);
    expect(reg.isConnected("u1")).toBe(false);
  });

  it("pushes an invocation to the device and resolves with its result", async () => {
    const sent: DeviceInvocation[] = [];
    reg.register("u1", ["calendar", "reminders"], (inv) => sent.push(inv));
    expect(reg.isConnected("u1")).toBe(true);
    expect(reg.capabilities("u1")).toEqual(["calendar", "reminders"]);

    const pending = reg.invoke("u1", "reminders_create", JSON.stringify({ title: "Milk" }));
    // The invocation was pushed down the device stream.
    expect(sent).toHaveLength(1);
    expect(sent[0].tool).toBe("reminders_create");
    expect(JSON.parse(sent[0].argsJson)).toEqual({ title: "Milk" });

    // The phone returns its result, correlated by id.
    reg.resolveResult("u1", sent[0].id, { ok: true, resultJson: '{"id":"r-1"}' });
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(r.resultJson).toBe('{"id":"r-1"}');
  });

  it("scopes per user — one user's device never serves another", async () => {
    reg.register("u1", ["calendar"], () => {});
    expect(reg.isConnected("u2")).toBe(false);
    const r = await reg.invoke("u2", "calendar_list_events", "{}");
    expect(r.ok).toBe(false);
  });

  it("rejects pending invocations when the device disconnects", async () => {
    let captured: DeviceInvocation | undefined;
    const unregister = reg.register("u1", [], (inv) => {
      captured = inv;
    });
    const pending = reg.invoke("u1", "calendar_list_events", "{}");
    expect(captured).toBeDefined();
    unregister();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disconnected/);
    expect(reg.isConnected("u1")).toBe(false);
  });

  it("times out when the device never answers", async () => {
    vi.useFakeTimers();
    reg.register("u1", [], () => {});
    const pending = reg.invoke("u1", "reminders_list", "{}");
    await vi.advanceTimersByTimeAsync(31_000);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not respond/);
  });

  it("a later connection supersedes an earlier one for the same user", async () => {
    const a: DeviceInvocation[] = [];
    const b: DeviceInvocation[] = [];
    reg.register("u1", ["calendar"], (inv) => a.push(inv));
    reg.register("u1", ["reminders"], (inv) => b.push(inv));
    expect(reg.capabilities("u1")).toEqual(["reminders"]);
    reg.invoke("u1", "reminders_list", "{}");
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});

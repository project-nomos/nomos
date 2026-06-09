import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry, getExponentialDelay, RetryError } from "./retry.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withRetry", () => {
  it("retries on 429 then resolves", async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls < 3) throw { status: 429 };
      return "ok";
    });
    const p = withRetry(op, { onRetry, maxRetries: 5 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on a non-retryable status (400), calling op once", async () => {
    const op = vi.fn(async () => {
      throw { status: 400 };
    });
    await expect(withRetry(op, {})).rejects.toMatchObject({ status: 400 });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("does not call op when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const op = vi.fn(async () => "x");
    await expect(withRetry(op, { signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(op).not.toHaveBeenCalled();
  });

  it("gives up with a RetryError after maxRetries on persistent 429", async () => {
    vi.useFakeTimers();
    const op = vi.fn(async () => {
      throw { status: 429 };
    });
    const p = withRetry(op, { maxRetries: 1 }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(RetryError);
    expect((err as RetryError).attempts).toBe(2);
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("getExponentialDelay", () => {
  it("grows with the attempt number and is capped at maxDelay (jitter aside)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // no jitter
    expect(getExponentialDelay(1, 100_000)).toBe(500); // BASE_DELAY * 2^0
    expect(getExponentialDelay(3, 100_000)).toBe(2000); // BASE_DELAY * 2^2
    expect(getExponentialDelay(100, 4000)).toBe(4000); // capped
  });
});

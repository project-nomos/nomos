import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const errorMock = vi.fn();
vi.mock("./logger.ts", () => {
  const stub = { error: errorMock, info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return { createLogger: () => stub, logger: stub };
});

const { handleUnhandledRejection, installRejectionHandler, isIgnorableRejection } =
  await import("./rejection-handler.ts");

describe("isIgnorableRejection", () => {
  it("suppresses the harmless ProcessTransport cleanup race", () => {
    expect(isIgnorableRejection(new Error("ProcessTransport is not ready for request 3"))).toBe(
      true,
    );
  });

  it("does NOT suppress a real channel auth failure", () => {
    expect(isIgnorableRejection(new Error("An API error occurred: invalid_auth"))).toBe(false);
  });

  it("does NOT suppress non-Error reasons", () => {
    expect(isIgnorableRejection("invalid_auth")).toBe(false);
    expect(isIgnorableRejection(undefined)).toBe(false);
  });
});

describe("handleUnhandledRejection", () => {
  beforeEach(() => {
    errorMock.mockClear();
  });

  // The regression: a revoked Slack/Discord/Telegram token surfaces as a
  // background rejection. The daemon must log it and stay up. Calling
  // process.exit here is what caused the launchd KeepAlive crash-loop.
  it("logs a real rejection but never exits the process", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    handleUnhandledRejection(new Error("An API error occurred: invalid_auth"));

    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("stays silent for the ignorable cleanup race", () => {
    handleUnhandledRejection(new Error("ProcessTransport is not ready"));
    expect(errorMock).not.toHaveBeenCalled();
  });
});

describe("installRejectionHandler", () => {
  it("registers exactly one unhandledRejection listener", () => {
    const before = process.listenerCount("unhandledRejection");
    installRejectionHandler();
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    process.removeListener("unhandledRejection", handleUnhandledRejection);
  });
});

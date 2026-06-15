import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInput } from "../engine.ts";
import { validateOp } from "../ops.ts";
import { SidecarProvider } from "./mediapipe-sidecar.ts";

const input: ProviderInput = {
  bytes: new Uint8Array([1, 2, 3, 4]),
  mime: "image/jpeg",
  params: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SidecarProvider", () => {
  it("is deterministic and supports retouch only", () => {
    const p = new SidecarProvider("http://127.0.0.1:8799");
    expect(p.kind).toBe("deterministic");
    expect(p.supports("retouch")).toBe(true);
    expect(p.supports("editSemantic")).toBe(false);
    expect(p.supports("adjust")).toBe(false);
  });

  it("POSTs the op + base64 image to /v1/edit and returns the decoded bytes", async () => {
    const outBytes = Buffer.from([9, 8, 7]);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        image_b64: outBytes.toString("base64"),
        mime: "image/jpeg",
        cost_usd: 0,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const p = new SidecarProvider("http://127.0.0.1:8799");
    const op = validateOp({ op: "retouch", params: { strength: 0.8 } });
    const out = await p.execute(op, input);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8799/v1/edit");
    const body = JSON.parse(init?.body as string);
    expect(body.op).toBe("retouch");
    expect(body.params).toEqual({ strength: 0.8 });
    expect(body.image_b64).toBe(Buffer.from(input.bytes).toString("base64"));
    expect(Buffer.from(out.bytes)).toEqual(outBytes);
    expect(out.costUsd).toBe(0);
    expect(out.provider).toBe("mediapipe-sidecar");
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    const p = new SidecarProvider("http://127.0.0.1:8799");
    const op = validateOp({ op: "retouch", params: {} });
    await expect(p.execute(op, input)).rejects.toThrow(/HTTP 500/);
  });

  it("throws on an empty image payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ image_b64: "" }) })),
    );
    const p = new SidecarProvider("http://127.0.0.1:8799");
    const op = validateOp({ op: "retouch", params: {} });
    await expect(p.execute(op, input)).rejects.toThrow(/empty response/);
  });
});

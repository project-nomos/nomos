import { afterEach, describe, expect, it } from "vitest";
import { StudioEngine } from "../studio/engine.ts";
import { buildStudioEngine, buildStudioMcpServer } from "./studio-mcp.ts";

describe("studio-mcp wiring", () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
  });

  it("builds an engine (deterministic provider only) without Google creds", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    expect(buildStudioEngine()).toBeInstanceOf(StudioEngine);
  });

  it("builds the per-user MCP server without throwing", () => {
    const server = buildStudioMcpServer("u1");
    expect(server).toBeDefined();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime, formatSystemMessage, isSilentTool } from "./agent-runtime.ts";

describe("isSilentTool: tool-use activity suppression", () => {
  it("hides plumbing / dedicated-card tools from the activity stream", () => {
    // Skill (loads a playbook) + MCP resource discovery + ToolSearch are internal
    // setup, not user actions; AskUserQuestion has its own Ask card.
    for (const t of [
      "Skill",
      "ToolSearch",
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
      "AskUserQuestion",
    ]) {
      expect(isSilentTool(t)).toBe(true);
    }
  });

  it("still surfaces real, user-meaningful tools", () => {
    for (const t of ["Bash", "WebSearch", "Edit", "mcp__google-calendar__calendar_create_event"]) {
      expect(isSilentTool(t)).toBe(false);
    }
  });
});

// buildIntegrationsSummary is private; we exercise it directly to lock in the
// mode-gated channel visibility (a hosted tenant must not be told it has BYO
// channels the host daemon happens to have configured).
type WithSummary = { buildIntegrationsSummary(): string };
const summaryOf = (): string =>
  (new AgentRuntime() as unknown as WithSummary).buildIntegrationsSummary();

describe("buildIntegrationsSummary channel visibility by mode", () => {
  const prior = {
    mode: process.env.NOMOS_MODE,
    jwks: process.env.AUTH_JWKS_URL,
    wa: process.env.WHATSAPP_ENABLED,
  };

  afterEach(() => {
    const restore = (
      k: "NOMOS_MODE" | "AUTH_JWKS_URL" | "WHATSAPP_ENABLED",
      v: string | undefined,
    ) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("NOMOS_MODE", prior.mode);
    restore("AUTH_JWKS_URL", prior.jwks);
    restore("WHATSAPP_ENABLED", prior.wa);
  });

  // The distinctive WhatsApp *channel entry* (not the bare word, which also appears in the
  // hosted reach-out line's "you do NOT have ... WhatsApp" disclaimer).
  const WA_ENTRY = "**WhatsApp**: Receive and respond";

  it("power-user mode advertises a configured BYO channel (WhatsApp)", () => {
    delete process.env.NOMOS_MODE;
    delete process.env.AUTH_JWKS_URL;
    process.env.WHATSAPP_ENABLED = "true";
    expect(summaryOf()).toContain(WA_ENTRY);
  });

  it("hosted mode suppresses BYO channels and presents the Nomos app as the only channel", () => {
    process.env.NOMOS_MODE = "hosted";
    // Configured on the host (e.g. a Mac daemon), but it must NOT be advertised to a
    // hosted tenant whose only channel is the app.
    process.env.WHATSAPP_ENABLED = "true";
    const summary = summaryOf();
    expect(summary).not.toContain(WA_ENTRY);
    expect(summary).toContain("**Nomos app**");
    expect(summary).toContain("this conversation IS the Nomos app");
  });
});

describe("formatSystemMessage: background-task lifecycle (Phase 3)", () => {
  it("renders task_started / task_notification / task_updated meaningfully", () => {
    expect(formatSystemMessage({ subtype: "task_started", description: "CI run for PR #96" })).toBe(
      "Background task started: CI run for PR #96",
    );
    expect(
      formatSystemMessage({
        subtype: "task_notification",
        status: "completed",
        summary: "deploy ok",
      }),
    ).toBe("Background task completed: deploy ok");
    expect(formatSystemMessage({ subtype: "task_updated", status: "running" })).toBe(
      "Background task running",
    );
  });

  it("preserves existing system subtypes", () => {
    expect(formatSystemMessage({ subtype: "init", tools: [1, 2], mcp_servers: [1] })).toBe(
      "2 tools, 1 MCP servers",
    );
    expect(formatSystemMessage({ subtype: "unknown_x" })).toBe("unknown_x");
  });
});

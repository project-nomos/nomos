import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the data/LLM dependencies so the reminder/triage formatting is deterministic.
vi.mock("../auth/org-members.ts", () => ({ listMemoryOwners: vi.fn() }));
vi.mock("./commitment-tracker.ts", () => ({
  getCommitmentsForReminder: vi.fn(),
  markReminded: vi.fn(async () => {}),
  expireOverdueCommitments: vi.fn(async () => 0),
}));
vi.mock("./priority-triage.ts", () => ({ generateTriage: vi.fn() }));

import { listMemoryOwners } from "../auth/org-members.ts";
import {
  getCommitmentsForReminder,
  markReminded,
  expireOverdueCommitments,
} from "./commitment-tracker.ts";
import { generateTriage } from "./priority-triage.ts";
import { runCommitmentReminders, runTriageDigest } from "./scheduler.ts";

const owners = listMemoryOwners as unknown as ReturnType<typeof vi.fn>;
const due = getCommitmentsForReminder as unknown as ReturnType<typeof vi.fn>;
const triage = generateTriage as unknown as ReturnType<typeof vi.fn>;

describe("runCommitmentReminders", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns one deliverable text block per owner with due reminders + marks them", async () => {
    owners.mockResolvedValue(["alice", "bob"]);
    due.mockImplementation(async (userId: string) =>
      userId === "alice"
        ? [{ id: "c1", description: "send the report", deadline: new Date("2026-06-10") }]
        : [],
    );

    const out = await runCommitmentReminders();
    expect(out).toHaveLength(1);
    expect(out[0]!.userId).toBe("alice");
    expect(out[0]!.text).toContain("send the report");
    expect(out[0]!.text).toContain("Commitment reminders");
    expect(markReminded).toHaveBeenCalledWith("alice", ["c1"]);
    // expireOverdueCommitments runs for every owner.
    expect(expireOverdueCommitments).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array when nothing is due", async () => {
    owners.mockResolvedValue(["alice"]);
    due.mockResolvedValue([]);
    expect(await runCommitmentReminders()).toEqual([]);
    expect(markReminded).not.toHaveBeenCalled();
  });
});

describe("runTriageDigest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns one digest per owner, formatting high/medium priority items", async () => {
    owners.mockResolvedValue(["alice"]);
    triage.mockResolvedValue({
      items: [
        {
          urgency: "high",
          contact: "x",
          contactName: "Dana",
          platform: "slack",
          messageCount: 3,
          reason: "asked twice",
        },
        { urgency: "medium", contact: "y", contactName: "Sam", platform: "email", messageCount: 1 },
      ],
    });
    const out = await runTriageDigest();
    expect(out).toHaveLength(1);
    expect(out[0]!.userId).toBe("alice");
    expect(out[0]!.text).toContain("High priority:");
    expect(out[0]!.text).toContain("Dana");
    expect(out[0]!.text).toContain("Needs attention:");
    expect(out[0]!.text).toContain("Sam");
  });

  it("omits owners with a quiet day (no items)", async () => {
    owners.mockResolvedValue(["alice"]);
    triage.mockResolvedValue({ items: [] });
    expect(await runTriageDigest()).toEqual([]);
  });
});

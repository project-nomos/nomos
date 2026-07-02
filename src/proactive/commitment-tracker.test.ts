import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb } from "../db/test-helpers.ts";

const mock = createMockDb();
vi.mock("../db/client.ts", () => ({ getKysely: () => mock.db }));
// searchContacts is only hit when a commitment names a contact; default to none.
vi.mock("../identity/contacts.ts", () => ({ searchContacts: vi.fn(async () => []) }));

const {
  storeCommitments,
  getActionItems,
  getCommitmentsDueForFollowUp,
  recordFollowUp,
  FOLLOW_UP_BACKOFF_DAYS,
  MAX_FOLLOW_UPS,
} = await import("./commitment-tracker.ts");

beforeEach(() => mock.reset());

describe("commitment-tracker action-item backbone", () => {
  it("seeds next_follow_up_at for a 'theirs' item but not a 'mine' item", async () => {
    // storeCommitments inserts + returns the row; queue one echo row per insert.
    mock.addResult([{ id: "x1" }]);
    await storeCommitments(
      "u1",
      [{ description: "they owe me the deck", deadline: null, contact: null, direction: "theirs" }],
      undefined,
      { source: "slack", sourceRef: "t-1" },
    );
    const insertTheirs = mock.getQueries().at(-1)!;
    expect(insertTheirs.parameters).toContain("theirs");
    expect(insertTheirs.parameters).toContain("slack");
    // A follow-up moment (a Date) is among the insert params for 'theirs'.
    expect(insertTheirs.parameters.some((p) => p instanceof Date)).toBe(true);

    mock.reset();
    mock.addResult([{ id: "x2" }]);
    await storeCommitments(
      "u1",
      [{ description: "I owe the report", deadline: null, contact: null, direction: "mine" }],
      undefined,
      { source: "chat" },
    );
    const insertMine = mock.getQueries().at(-1)!;
    expect(insertMine.parameters).toContain("mine");
    // No deadline + 'mine' → no follow-up Date seeded.
    expect(insertMine.parameters.some((p) => p instanceof Date)).toBe(false);
  });

  it("getActionItems ranks priority first (NULLS last) then deadline", async () => {
    mock.addResult([]);
    await getActionItems("u1", { direction: "mine", limit: 10 });
    const q = mock.getQueries().at(-1)!;
    expect(q.sql).toMatch(/order by priority ASC NULLS LAST/i);
    expect(q.sql).toMatch(/deadline ASC NULLS LAST/i);
    // direction + status + user_id are all constrained.
    expect(q.parameters).toContain("mine");
    expect(q.parameters).toContain("pending");
    expect(q.parameters).toContain("u1");
  });

  it("getCommitmentsDueForFollowUp filters theirs/pending under the cap", async () => {
    mock.addResult([]);
    await getCommitmentsDueForFollowUp("u1");
    const q = mock.getQueries().at(-1)!;
    expect(q.parameters).toContain("theirs");
    expect(q.parameters).toContain("pending");
    // The cap (MAX_FOLLOW_UPS) is bound as a parameter.
    expect(q.parameters).toContain(MAX_FOLLOW_UPS);
  });

  it("recordFollowUp bumps the counter and reschedules per the backoff", async () => {
    // First query: SELECT follow_up_count → 0. Then the UPDATE.
    mock.addResult([{ follow_up_count: 0 }]);
    mock.addResult([]);
    await recordFollowUp("u1", "c1");
    const update = mock.getQueries().at(-1)!;
    // nextCount = 1, nextDays = FOLLOW_UP_BACKOFF_DAYS[1]; next_follow_up_at is
    // rescheduled via `now() + interval '1 day' * <days>`.
    expect(update.parameters).toContain(1);
    expect(update.parameters).toContain(FOLLOW_UP_BACKOFF_DAYS[1]);
    expect(update.sql.toLowerCase()).toContain("interval");
  });

  it("recordFollowUp clears the schedule once the backoff is exhausted", async () => {
    // At the last slot, there is no next backoff day → next_follow_up_at = null.
    mock.addResult([{ follow_up_count: MAX_FOLLOW_UPS - 1 }]);
    mock.addResult([]);
    await recordFollowUp("u1", "c1");
    const update = mock.getQueries().at(-1)!;
    // Counter reaches the cap; there is no next backoff day so next_follow_up_at
    // is set to a null literal (no `interval` reschedule in the SQL).
    expect(update.parameters).toContain(MAX_FOLLOW_UPS);
    expect(update.sql.toLowerCase()).not.toContain("interval");
  });
});

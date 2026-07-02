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

  it("recordFollowUp is a single atomic UPDATE that increments in-DB + rebuilds the schedule", async () => {
    // No SELECT first: one UPDATE that computes follow_up_count + 1 in the DB and
    // rebuilds next_follow_up_at from a CASE over the backoff array.
    mock.addResult([]);
    await recordFollowUp("u1", "c1");
    const queries = mock.getQueries();
    expect(queries.length).toBe(1); // atomic — no read-then-write
    const update = queries[0]!;
    const s = update.sql.toLowerCase();
    // Increment happens in-SQL, and the reschedule is a CASE that falls through to
    // NULL once the backoff is exhausted (so exhausted items leave the sweep).
    expect(s).toContain("follow_up_count + 1");
    expect(s).toContain("case");
    expect(s).toContain("interval");
    expect(s).toContain("else null");
    // The between-nudge backoff days (indices 1..N-1) are bound as params.
    for (const days of FOLLOW_UP_BACKOFF_DAYS.slice(1)) {
      expect(update.parameters).toContain(days);
    }
  });
});

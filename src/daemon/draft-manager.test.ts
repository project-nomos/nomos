import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DraftRow } from "../db/drafts.ts";

vi.mock("../db/drafts.ts", () => ({
  createDraft: vi.fn(),
  approveDraft: vi.fn(),
  rejectDraft: vi.fn(),
  markDraftSent: vi.fn(),
}));

import { DraftManager } from "./draft-manager.ts";
import * as drafts from "../db/drafts.ts";

function fakeDraft(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: "abcd1234",
    platform: "classroom",
    channel_id: "course1",
    thread_id: null,
    user_id: "local",
    in_reply_to: "cw1",
    content: "my essay",
    context: {
      kind: "classroom_submission",
      courseId: "course1",
      courseWorkId: "cw1",
      submissionId: "sub1",
      attachAs: "doc",
    },
    status: "approved",
    created_at: new Date(0),
    approved_at: new Date(0),
    sent_at: null,
    expires_at: new Date(0),
    ...over,
  };
}

describe("DraftManager approve-action dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the registered action for the draft kind instead of a channel send", async () => {
    vi.mocked(drafts.approveDraft).mockResolvedValue(fakeDraft());
    vi.mocked(drafts.markDraftSent).mockResolvedValue(fakeDraft());

    const mgr = new DraftManager();
    const action = vi.fn().mockResolvedValue(undefined);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    mgr.registerApproveAction("classroom_submission", action);
    mgr.registerSendFn("classroom", sendFn);

    const res = await mgr.approve("abcd1234");

    expect(res.success).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(sendFn).not.toHaveBeenCalled();
    expect(drafts.markDraftSent).toHaveBeenCalledWith("abcd1234");
  });

  it("falls back to the channel send for plain message drafts", async () => {
    vi.mocked(drafts.approveDraft).mockResolvedValue(fakeDraft({ platform: "slack", context: {} }));
    vi.mocked(drafts.markDraftSent).mockResolvedValue(fakeDraft({ platform: "slack" }));

    const mgr = new DraftManager();
    const sendFn = vi.fn().mockResolvedValue(undefined);
    mgr.registerSendFn("slack", sendFn);

    const res = await mgr.approve("abcd1234");

    expect(res.success).toBe(true);
    expect(sendFn).toHaveBeenCalledOnce();
  });

  it("approveWithEdit runs the action with the EDITED content, then marks sent", async () => {
    vi.mocked(drafts.approveDraft).mockResolvedValue(fakeDraft());
    vi.mocked(drafts.markDraftSent).mockResolvedValue(fakeDraft());

    const mgr = new DraftManager();
    const action = vi.fn().mockResolvedValue(undefined);
    mgr.registerApproveAction("classroom_submission", action);

    const res = await mgr.approveWithEdit("abcd1234", "my EDITED essay");

    expect(res.success).toBe(true);
    // The action (handleClassroomSubmit) must receive the student's edited version.
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ id: "abcd1234" }),
      "my EDITED essay",
    );
    expect(drafts.markDraftSent).toHaveBeenCalledWith("abcd1234");
  });

  it("returns failure (and does not mark sent) when the action throws", async () => {
    vi.mocked(drafts.approveDraft).mockResolvedValue(fakeDraft());

    const mgr = new DraftManager();
    mgr.registerApproveAction("classroom_submission", vi.fn().mockRejectedValue(new Error("boom")));

    const res = await mgr.approve("abcd1234");

    expect(res.success).toBe(false);
    expect(drafts.markDraftSent).not.toHaveBeenCalled();
  });
});

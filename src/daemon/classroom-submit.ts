/**
 * Classroom submission approve-action (HOSTED).
 *
 * Registered with DraftManager for the `classroom_submission` draft kind. Classroom
 * submission drafts are only ever created by the hosted Classroom MCP tool
 * (`classroom_draft_submission`), so this runs in hosted mode when the student
 * approves (or approves-with-edit) a homework draft — schoolwork is never turned in
 * without explicit consent. (Power-user homework goes through the gws CLI directly.)
 *
 * On approval: build the (possibly edited) work into a Google Doc (or use a provided
 * link), attach it to the student's submission, then turn it in. Audited via the log.
 */

import type { DraftRow } from "../db/drafts.ts";
import { buildClassroomApi, type ClassroomAttachment } from "../sdk/google-classroom-api.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("classroom-submit");

interface SubmissionContext {
  courseId: string;
  courseWorkId: string;
  submissionId: string;
  attachAs: "doc" | "link";
  title: string;
  link?: string;
  account?: string;
  courseName?: string;
  assignmentTitle?: string;
}

function readContext(draft: DraftRow): SubmissionContext | null {
  const c = draft.context ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const courseId = str(c.courseId);
  const courseWorkId = str(c.courseWorkId);
  const submissionId = str(c.submissionId);
  if (!courseId || !courseWorkId || !submissionId) return null;
  return {
    courseId,
    courseWorkId,
    submissionId,
    attachAs: c.attachAs === "link" ? "link" : "doc",
    title: str(c.title) ?? "Submission",
    link: str(c.link),
    account: str(c.account),
    courseName: str(c.courseName),
    assignmentTitle: str(c.assignmentTitle),
  };
}

/**
 * DraftManager approve-action for kind `classroom_submission`. Attaches the work
 * and turns it in. `editedContent` is the student's edited version when they
 * approved-with-edit; otherwise the original draft content is used.
 */
export async function handleClassroomSubmit(
  draft: DraftRow,
  editedContent?: string,
): Promise<void> {
  const ctx = readContext(draft);
  if (!ctx)
    throw new Error("classroom submission draft is missing course/courseWork/submission ids");

  const api = buildClassroomApi({ userId: draft.user_id, account: ctx.account });
  const content = editedContent ?? draft.content;

  let attachment: ClassroomAttachment;
  if (ctx.attachAs === "link") {
    if (!ctx.link) throw new Error("classroom submission draft has attachAs='link' but no link");
    attachment = { link: { url: ctx.link } };
  } else {
    const doc = await api.createDoc(ctx.title, content);
    attachment = { driveFile: { id: doc.documentId } };
  }

  await api.modifyAttachments(ctx.courseId, ctx.courseWorkId, ctx.submissionId, [attachment]);
  await api.turnInSubmission(ctx.courseId, ctx.courseWorkId, ctx.submissionId);

  // Audit trail (structured log — hosted has no local filesystem).
  const label = `${ctx.courseName ?? ctx.courseId} · ${ctx.assignmentTitle ?? ctx.courseWorkId}`;
  log.info(
    {
      userId: draft.user_id,
      courseId: ctx.courseId,
      courseWorkId: ctx.courseWorkId,
      submissionId: ctx.submissionId,
      attachAs: ctx.attachAs,
      edited: editedContent !== undefined,
    },
    `Classroom assignment turned in: ${label}`,
  );
}

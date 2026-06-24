/**
 * Google Classroom MCP server (in-process).
 *
 * Exposes the student-assistant tools to the agent via the REST `buildClassroomApi`
 * (HOSTED only — power-user uses the gws CLI). Read tools are always present; the
 * write path is gated by `writeEnabled`.
 *
 * Submission is intentionally consent-gated: the agent gets `classroom_draft_submission`
 * (which stages the student's work as a DraftManager draft for accept/edit/decline) but
 * NO direct turn-in tool — it can never submit schoolwork on its own. The actual
 * attach + turn-in runs only when the student approves the draft
 * (src/daemon/classroom-submit.ts). `classroom_reclaim` (un-submit) is reversible.
 *
 * Gated as a unit by FEATURES.classroom() at the agent-runtime registration site.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { buildClassroomApi } from "./google-classroom-api.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("google-classroom-mcp");

/** Callback the agent-runtime supplies to stage a homework submission as a draft. */
export type CreateClassroomDraft = (args: {
  userId: string;
  courseId: string;
  courseWorkId: string;
  submissionId: string;
  title: string;
  body: string;
  attachAs: "doc" | "link";
  link?: string;
  account?: string;
  courseName?: string;
  assignmentTitle?: string;
}) => Promise<{ draftId: string } | null>;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}
function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const accountParam = z
  .string()
  .optional()
  .describe("Email of the connected Google account to use. Defaults to the default account.");

export interface ClassroomMcpOptions {
  /** Owner user id (the hosted REST token lifecycle + draft ownership). */
  userId: string;
  /** Whether the read-WRITE coursework scope is present (enables draft-submit + reclaim). */
  writeEnabled: boolean;
  /**
   * The connected account that holds the classroom scopes (e.g. the student's SCHOOL
   * account). Tools default to it, so Classroom uses the right account even when the
   * user's DEFAULT Google account (personal, Gmail/Cal/Drive) is a different one. An
   * explicit `account` tool arg still overrides.
   */
  defaultAccount?: string;
  /** Stage a homework submission as a DraftManager draft (accept/edit/decline). */
  createDraft: CreateClassroomDraft;
}

/**
 * Compose the in-process Classroom MCP server (HOSTED only — power-user uses the gws
 * CLI via the gws-classroom skill, not this server).
 */
export function buildClassroomMcpServer(opts: ClassroomMcpOptions): McpSdkServerConfigWithInstance {
  const { userId, writeEnabled } = opts;
  const api = (account?: string) =>
    buildClassroomApi({ userId, account: account ?? opts.defaultAccount });

  // ── Read tools ──

  const listCourses = tool(
    "classroom_list_courses",
    "List the student's active Google Classroom courses. Returns id, name, section, room, ownerId, courseState, alternateLink.",
    {
      includeArchived: z
        .boolean()
        .optional()
        .describe("Include ARCHIVED courses (default: active only)."),
      account: accountParam,
    },
    async (args) => {
      try {
        const data = await api(args.account).listCourses({
          courseStates: args.includeArchived ? ["ACTIVE", "ARCHIVED"] : ["ACTIVE"],
        });
        return jsonResult(data);
      } catch (err) {
        return errorResult(
          `classroom_list_courses failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const listCourseWork = tool(
    "classroom_list_coursework",
    "List published coursework (assignments) for a course, ordered by due date. Returns id, title, description, dueDate, dueTime, maxPoints, workType, alternateLink, materials.",
    { courseId: z.string(), account: accountParam },
    async (args) => {
      try {
        const data = await api(args.account).listCourseWork(args.courseId, {});
        return jsonResult(data);
      } catch (err) {
        return errorResult(
          `classroom_list_coursework failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const getCourseWork = tool(
    "classroom_get_coursework",
    "Fetch one assignment in full (description, materials, due date, points, submission settings).",
    { courseId: z.string(), id: z.string().describe("courseWork id."), account: accountParam },
    async (args) => {
      try {
        const data = await api(args.account).getCourseWork(args.courseId, args.id);
        return jsonResult(data);
      } catch (err) {
        return errorResult(
          `classroom_get_coursework failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const listAnnouncements = tool(
    "classroom_list_announcements",
    "List a course's announcements (text, materials, alternateLink, updateTime).",
    { courseId: z.string(), account: accountParam },
    async (args) => {
      try {
        const data = await api(args.account).listAnnouncements(args.courseId, {});
        return jsonResult(data);
      } catch (err) {
        return errorResult(
          `classroom_list_announcements failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const listMaterials = tool(
    "classroom_list_coursework_materials",
    "List a course's posted study materials (readings, slides, links). Useful for exam prep — the topics and resources a teacher shared.",
    { courseId: z.string(), account: accountParam },
    async (args) => {
      try {
        const data = await api(args.account).listCourseWorkMaterials(args.courseId, {});
        return jsonResult(data);
      } catch (err) {
        return errorResult(
          `classroom_list_coursework_materials failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const listSubmissions = tool(
    "classroom_list_submissions",
    "List the student's own submissions for a course's coursework. Returns id, state (NEW/CREATED/TURNED_IN/RETURNED), late, assignedGrade, alternateLink. Pass courseWorkId='-' to sweep ALL coursework in the course (e.g. to find what hasn't been turned in, or to read past grades for exam prep).",
    {
      courseId: z.string(),
      courseWorkId: z
        .string()
        .describe("A courseWork id, or '-' for all coursework in the course."),
      states: z
        .array(z.enum(["NEW", "CREATED", "TURNED_IN", "RETURNED", "RECLAIMED_BY_STUDENT"]))
        .optional()
        .describe("Filter by submission state."),
      account: accountParam,
    },
    async (args) => {
      try {
        const data = await api(args.account).listSubmissions(args.courseId, args.courseWorkId, {
          states: args.states,
        });
        return jsonResult(data);
      } catch (err) {
        return errorResult(
          `classroom_list_submissions failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  // ── Write tools (gated) ──

  const draftSubmission = tool(
    "classroom_draft_submission",
    "Stage the student's drafted work for an assignment as a DRAFT requiring their approval (accept / edit / decline) — it does NOT submit anything. On approval, the work is attached and turned in automatically. ALWAYS show the student the drafted work and let them approve; never represent unapproved work as submitted. Use attachAs='doc' to turn the body into a Google Doc attachment (most written work), or attachAs='link' with a link to an existing document.",
    {
      courseId: z.string(),
      courseWorkId: z.string(),
      submissionId: z
        .string()
        .describe("The student's studentSubmission id (from classroom_list_submissions)."),
      title: z.string().describe("Title for the submission document / a short label for the work."),
      body: z
        .string()
        .describe(
          "The drafted work to submit (becomes the Google Doc contents for attachAs='doc').",
        ),
      attachAs: z.enum(["doc", "link"]).default("doc"),
      link: z
        .string()
        .optional()
        .describe("Required when attachAs='link': URL of the document to attach."),
      courseName: z.string().optional(),
      assignmentTitle: z.string().optional(),
      account: accountParam,
    },
    async (args) => {
      try {
        if (args.attachAs === "link" && !args.link) {
          return errorResult("classroom_draft_submission: attachAs='link' requires a `link`.");
        }
        const draft = await opts.createDraft({
          userId,
          courseId: args.courseId,
          courseWorkId: args.courseWorkId,
          submissionId: args.submissionId,
          title: args.title,
          body: args.body,
          attachAs: args.attachAs,
          link: args.link,
          account: args.account ?? opts.defaultAccount,
          courseName: args.courseName,
          assignmentTitle: args.assignmentTitle,
        });
        if (!draft) {
          return errorResult(
            "Could not stage the submission draft (draft manager unavailable). Show the student the work and ask them to submit manually.",
          );
        }
        return jsonResult({
          draftId: draft.draftId,
          status: "pending_approval",
          message:
            "Submission drafted and queued for the student's approval (accept / edit / decline). It will be turned in only after they approve.",
        });
      } catch (err) {
        return errorResult(
          `classroom_draft_submission failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  const reclaim = tool(
    "classroom_reclaim",
    "Un-submit (reclaim) a previously turned-in assignment so it can be edited and resubmitted. Reversible. Confirm with the student first.",
    {
      courseId: z.string(),
      courseWorkId: z.string(),
      submissionId: z.string(),
      account: accountParam,
    },
    async (args) => {
      try {
        await api(args.account).reclaimSubmission(
          args.courseId,
          args.courseWorkId,
          args.submissionId,
        );
        return jsonResult({ reclaimed: args.submissionId });
      } catch (err) {
        return errorResult(`classroom_reclaim failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  const tools = [
    listCourses,
    listCourseWork,
    getCourseWork,
    listAnnouncements,
    listMaterials,
    listSubmissions,
    ...(writeEnabled ? [draftSubmission, reclaim] : []),
  ];

  log.info(
    { writeEnabled, tools: tools.length },
    "registered Google Classroom MCP server (hosted)",
  );

  return createSdkMcpServer({ name: "nomos-google-classroom", version: "1.0.0", tools });
}

/**
 * Google Classroom REST API transport — HOSTED mode only.
 *
 * Hosted has no Bash/gws CLI, so it reaches Classroom through these direct calls to
 * classroom.googleapis.com / docs.googleapis.com via `gapiFetch` (per-account OAuth
 * token resolved + refreshed at call time). Power-user mode does NOT use this — it
 * drives the gws CLI directly via the `gws-classroom` skill.
 *
 * Shared by the Classroom MCP server (read + draft tools) and the daemon's draft
 * approve handler (src/daemon/classroom-submit.ts).
 *
 * Submission documents reuse the `drive.file` scope already granted (the Docs API
 * accepts drive.file for app-created files), so no extra scope is needed.
 */

import { gapiFetch } from "./google-rest-mcp.ts";

const CLASSROOM = "https://classroom.googleapis.com/v1";
const DOCS = "https://docs.googleapis.com/v1";

type QueryVal = string | number | boolean | undefined;
type Query = Record<string, QueryVal | QueryVal[]>;

/** A Classroom submission attachment to add before turn-in. */
export type ClassroomAttachment = { driveFile: { id: string } } | { link: { url: string } };

/** Backend-agnostic Classroom operations. Reads return parsed JSON; writes resolve void/JSON. */
export interface ClassroomApi {
  listCourses(p: { courseStates?: string[]; pageSize?: number }): Promise<unknown>;
  listCourseWork(
    courseId: string,
    p: { orderBy?: string; courseWorkStates?: string[]; pageSize?: number },
  ): Promise<unknown>;
  getCourseWork(courseId: string, id: string): Promise<unknown>;
  listAnnouncements(courseId: string, p: { pageSize?: number }): Promise<unknown>;
  listCourseWorkMaterials(courseId: string, p: { pageSize?: number }): Promise<unknown>;
  listSubmissions(
    courseId: string,
    courseWorkId: string,
    p: { states?: string[]; pageSize?: number },
  ): Promise<unknown>;
  reclaimSubmission(courseId: string, courseWorkId: string, id: string): Promise<void>;
  turnInSubmission(courseId: string, courseWorkId: string, id: string): Promise<void>;
  modifyAttachments(
    courseId: string,
    courseWorkId: string,
    id: string,
    addAttachments: ClassroomAttachment[],
  ): Promise<unknown>;
  /** Create a Google Doc with `text`, returning its Drive file id (for an attachment). */
  createDoc(title: string, text: string): Promise<{ documentId: string }>;
}

function submissionsPath(courseId: string, courseWorkId: string): string {
  return `${CLASSROOM}/courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(
    courseWorkId,
  )}/studentSubmissions`;
}

/** Pages a Classroom list endpoint until exhausted, so we don't silently truncate at
 *  one pageSize (e.g. "what hasn't been turned in" must see ALL submissions). Bounded
 *  by MAX_PAGES; on hitting it the result carries `_truncated: true` so it's never silent. */
const MAX_PAGES = 20;
async function paginate(
  get: (url: string, query?: Query) => Promise<unknown>,
  url: string,
  query: Query,
  itemsKey: string,
): Promise<Record<string, unknown>> {
  const all: unknown[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const resp = (await get(url, { ...query, pageToken })) as Record<string, unknown>;
    const items = resp[itemsKey];
    if (Array.isArray(items)) all.push(...items);
    pageToken = typeof resp.nextPageToken === "string" ? resp.nextPageToken : undefined;
    pages += 1;
  } while (pageToken && pages < MAX_PAGES);
  return pageToken ? { [itemsKey]: all, _truncated: true } : { [itemsKey]: all };
}

/**
 * Build a hosted (REST) Classroom API bound to a user + optional account. Uses our
 * OAuth token lifecycle (refreshed per call). `account` defaults to the user's
 * default Google account.
 */
export function buildClassroomApi(opts: { userId: string; account?: string }): ClassroomApi {
  const { userId, account } = opts;
  const get = (url: string, query?: Query) =>
    gapiFetch({ userId, account, method: "GET", url, query });
  const post = (url: string, body?: unknown) =>
    gapiFetch({ userId, account, method: "POST", url, body });

  return {
    listCourses: (p) =>
      paginate(
        get,
        `${CLASSROOM}/courses`,
        { studentId: "me", courseStates: p.courseStates ?? ["ACTIVE"], pageSize: p.pageSize ?? 50 },
        "courses",
      ),
    listCourseWork: (courseId, p) =>
      paginate(
        get,
        `${CLASSROOM}/courses/${encodeURIComponent(courseId)}/courseWork`,
        {
          orderBy: p.orderBy ?? "dueDate asc",
          courseWorkStates: p.courseWorkStates ?? ["PUBLISHED"],
          pageSize: p.pageSize ?? 50,
        },
        "courseWork",
      ),
    getCourseWork: (courseId, id) =>
      get(
        `${CLASSROOM}/courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(id)}`,
      ),
    listAnnouncements: (courseId, p) =>
      paginate(
        get,
        `${CLASSROOM}/courses/${encodeURIComponent(courseId)}/announcements`,
        { pageSize: p.pageSize ?? 20 },
        "announcements",
      ),
    listCourseWorkMaterials: (courseId, p) =>
      paginate(
        get,
        `${CLASSROOM}/courses/${encodeURIComponent(courseId)}/courseWorkMaterials`,
        { pageSize: p.pageSize ?? 20 },
        "courseWorkMaterial",
      ),
    listSubmissions: (courseId, courseWorkId, p) =>
      paginate(
        get,
        submissionsPath(courseId, courseWorkId),
        { userId: "me", states: p.states, pageSize: p.pageSize ?? 50 },
        "studentSubmissions",
      ),
    reclaimSubmission: async (courseId, courseWorkId, id) => {
      await post(
        `${submissionsPath(courseId, courseWorkId)}/${encodeURIComponent(id)}:reclaim`,
        {},
      );
    },
    turnInSubmission: async (courseId, courseWorkId, id) => {
      await post(`${submissionsPath(courseId, courseWorkId)}/${encodeURIComponent(id)}:turnIn`, {});
    },
    modifyAttachments: (courseId, courseWorkId, id, addAttachments) =>
      post(
        `${submissionsPath(courseId, courseWorkId)}/${encodeURIComponent(id)}:modifyAttachments`,
        { addAttachments },
      ),
    createDoc: async (title, text) => {
      const doc = (await post(`${DOCS}/documents`, { title })) as { documentId?: string };
      if (!doc.documentId) throw new Error("Docs API did not return a documentId");
      await post(`${DOCS}/documents/${doc.documentId}:batchUpdate`, {
        requests: [{ insertText: { endOfSegmentLocation: {}, text } }],
      });
      return { documentId: doc.documentId };
    },
  };
}

---
name: gws-classroom
version: 1.0.0
description: "Google Classroom: track due work, draft + submit homework with approval, and exam prep — via the gws CLI."
metadata:
  openclaw:
    category: "education"
    requires:
      bins: ["gws"]
    cliHelp: "gws classroom --help"
---

# classroom (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, run `gws generate-skills` to create it.

Power-user student assistant for Google Classroom. Drive it through the `gws` CLI:

```bash
gws classroom <resource> <method> --params '<json>' [--json '<body>']
```

Read freely; **never turn in work without the student's explicit OK** in chat.

## What's due / not turned in

```bash
# 1. Active courses
gws classroom courses list --params '{"studentId":"me","courseStates":["ACTIVE"]}'

# 2. Per course: assignments by due date, and my submissions (courseWorkId "-" = all)
gws classroom courses courseWork list --params '{"courseId":"<id>","orderBy":"dueDate asc","courseWorkStates":["PUBLISHED"]}'
gws classroom courses courseWork studentSubmissions list --params '{"courseId":"<id>","courseWorkId":"-","userId":"me"}'
```

Coursework is outstanding when its submission `state` is not `TURNED_IN` or `RETURNED`.
Report course, title, due date, and whether it's late.

## Drafting + submitting homework (confirm first)

1. Read the assignment and its materials:
   `gws classroom courses courseWork get --params '{"courseId":"<id>","id":"<cwId>"}'`
2. Draft the student's work and **show it to them**. Wait for explicit approval.
3. On approval, attach + turn in (the `id` is the studentSubmission id):

   ```bash
   # Option A — attach a Google Doc you create from the drafted text:
   gws docs documents create --json '{"title":"<title>"}'
   gws docs documents batchUpdate --params '{"documentId":"<docId>"}' \
     --json '{"requests":[{"insertText":{"endOfSegmentLocation":{},"text":"<body>"}}]}'
   gws classroom courses courseWork studentSubmissions modifyAttachments \
     --params '{"courseId":"<id>","courseWorkId":"<cwId>","id":"<subId>"}' \
     --json '{"addAttachments":[{"driveFile":{"id":"<docId>"}}]}'

   # Option B — attach an existing link instead of a doc:
   #   ...modifyAttachments ... --json '{"addAttachments":[{"link":{"url":"<url>"}}]}'

   # Then turn it in:
   gws classroom courses courseWork studentSubmissions turnIn \
     --params '{"courseId":"<id>","courseWorkId":"<cwId>","id":"<subId>"}' --json '{}'
   ```

4. To undo: `... studentSubmissions reclaim --params '{...}' --json '{}'`.

## Exam / test prep

```bash
gws classroom courses courseWorkMaterials list --params '{"courseId":"<id>"}'
```

Combine posted materials with past grades (`assignedGrade` from `studentSubmissions list`)
to find weak topics, then build a targeted study plan citing the actual materials. Save the
student's recurring weak areas to long-term memory (the vault) so prep sharpens over time.

## Discovering Commands

```bash
gws classroom --help
gws schema classroom.<resource>.<method>
```

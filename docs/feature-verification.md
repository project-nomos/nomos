# Feature Verification Guide

Step-by-step instructions to verify every new advanced feature. Each section includes prerequisites, how to test, and what success looks like.

---

## Prerequisites (All Features)

```bash
# Ensure deps are installed and project builds
pnpm install
pnpm build

# Ensure database is running with pgvector
# DATABASE_URL must be set in .env or .env.local

# Run migrations
pnpm dev -- db migrate

# Verify tests pass
pnpm test
```

---

## 1. Interactive Browser Automation

**Prerequisites:**

- Playwright Chromium installed (auto-installed via `postinstall` hook, or run `npx playwright install chromium`)

**How to test (CLI):**

```bash
pnpm dev -- chat
```

Then ask the agent:

```
Navigate to https://example.com, take a screenshot, and tell me the page title.
```

**Expected behavior:**

1. Agent calls `browser_navigate` with URL
2. Agent calls `browser_screenshot` — returns a PNG image
3. Agent calls `browser_snapshot` or `browser_evaluate` to read the title
4. Agent reports the page title ("Example Domain")

**Multi-step test:**

```
Go to https://news.ycombinator.com, click on the first story link, then take a screenshot.
```

Expected: Agent uses `browser_navigate` → `browser_snapshot` (to find selectors) → `browser_click` → `browser_screenshot`.

**Cleanup test:**

```
Close the browser session.
```

Expected: Agent calls `browser_close`, confirms session closed.

**Tools to verify:** `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_select`, `browser_evaluate`, `browser_snapshot`, `browser_close`

---

## 2. Task State Machine & Dependency Graph

**Prerequisites:**

- Daemon running: `pnpm dev -- daemon run`

**How to test (CLI connected to daemon):**

```bash
# In a separate terminal
pnpm dev -- chat
```

Then ask:

```
Show me all running tasks.
```

**Expected:** Agent calls `task_status` and lists active tasks (may be empty if idle).

**Test during active work:**

Send a long-running prompt to the daemon (e.g., via Slack or a second CLI session), then in your CLI session:

```
What tasks are currently running?
```

**Expected:** Shows the active task with ID, name, source, status (`running`), and duration.

**Kill test:**

```
Kill task <first-8-chars-of-task-id>
```

**Expected:** Agent calls `task_kill`, confirms the task was killed.

**Dependency graph verification (programmatic):**

```typescript
import { TaskManager } from "./src/daemon/task-manager.ts";

const tm = new TaskManager();
const taskA = tm.create({ name: "build", description: "Build project", source: "test" });
const taskB = tm.create({
  name: "test",
  description: "Run tests",
  source: "test",
  blockedBy: [taskA.id],
});

console.log("B is ready?", tm.isReady(taskB.id)); // false
console.log("A blocks:", taskA.blocks); // [taskB.id]

tm.start(taskA.id);
tm.complete(taskA.id);

console.log("B is ready?", tm.isReady(taskB.id)); // true

// Cycle detection
const taskC = tm.create({ name: "deploy", description: "Deploy", source: "test" });
const taskD = tm.create({
  name: "notify",
  description: "Notify",
  source: "test",
  blockedBy: [taskC.id],
});
console.log("Cycle?", tm.addDependency(taskC.id, taskD.id)); // false (would create cycle)
```

---

## 3. Sleep & Self-Resume

**How to test (CLI):**

```bash
pnpm dev -- chat
```

Ask:

```
Sleep for 10 seconds, then tell me what time it is.
```

**Expected behavior:**

1. Agent calls `agent_sleep` with `duration_seconds: 10` and a `wake_prompt`
2. CLI pauses for ~10 seconds (no output during sleep)
3. Agent wakes up and executes the wake prompt (reports the time)

**Short sleep test:**

```
Wait 5 seconds then check if my current directory has any .ts files.
```

**Expected:** Agent sleeps 5s, wakes, runs a glob/bash to check.

---

## 4. Plan Mode

**How to test (CLI):**

```bash
pnpm dev -- chat
```

Ask:

```
I want to refactor the database module to use connection pooling. Propose a plan first.
```

**Expected behavior:**

1. Agent calls `propose_plan` with:
   - `title`: something like "Refactor DB connection pooling"
   - `summary`: 1-2 sentences
   - `steps`: array of steps with descriptions, files, and risk levels
2. Output shows a formatted plan with numbered steps
3. Plan is stored in the `config` DB table with key `plan.plan-<timestamp>`
4. Agent asks you to approve, modify, or reject

**Verify DB storage:**

```sql
SELECT key, value FROM config WHERE key LIKE 'plan.%' ORDER BY updated_at DESC LIMIT 1;
```

---

## 5. LSP Code Intelligence

**Prerequisites:**

- `typescript-language-server` available via npx (installed as a transitive dep of TypeScript tooling, or install globally: `npm i -g typescript-language-server typescript`)

**How to test (CLI):**

```bash
pnpm dev -- chat
```

**Go-to-definition:**

```
What is the definition of the `TaskManager` class? Use LSP to find it in src/daemon/task-manager.ts at line 66, character 14.
```

**Expected:** Agent calls `lsp_go_to_definition`, returns the file path and line number.

**Hover:**

```
Use LSP hover on the `consolidateMemory` function in src/memory/consolidator.ts at line 43, character 20.
```

**Expected:** Agent calls `lsp_hover`, returns the type signature and any JSDoc.

**Document symbols:**

```
List all symbols in src/daemon/task-manager.ts using LSP.
```

**Expected:** Agent calls `lsp_document_symbols`, returns a hierarchical list like:

```
[Class] TaskManager (L66-292)
  [Method] create (L71-103)
  [Method] addDependency (L106-122)
  ...
[Function] getTaskManager (L297-302)
```

**Find references:**

```
Find all references to `getTaskManager` across the project. The function is at line 297, character 17 of src/daemon/task-manager.ts.
```

**Expected:** Returns file paths and line numbers where `getTaskManager` is imported/used.

**Note:** First LSP call may take a few seconds while the language server initializes. Subsequent calls are faster.

---

## 6. Proactive Messaging

**Prerequisites:**

- Daemon running with at least one channel adapter (Slack, Discord, or Telegram)
- Default notification channel configured (via Settings UI or `notification_defaults` DB table)

**How to test (via daemon):**

```bash
pnpm dev -- daemon run
```

In a CLI session connected to the daemon:

```
Send a proactive message saying "Hello from Nomos!" to my notification channel.
```

**Expected:**

1. Agent calls `proactive_send` with the message
2. If no target specified, it resolves the default notification channel
3. Tool emits `proactive:send` process event
4. Gateway picks it up and routes through the channel adapter
5. Message appears in your Slack/Discord/Telegram channel
6. Tool confirms: "Proactive message sent to <platform>/<channelId>"

**Without daemon (expected failure):**

```bash
pnpm dev -- chat  # Direct CLI, no daemon
```

```
Send a proactive message saying "test" to slack.
```

**Expected:** Returns "Message queued for delivery... (adapter may not be active)" since no channel manager is running.

**Urgency levels:**

```
Send an urgent proactive message: "Build failed on main branch!"
```

**Expected:** Message prefixed with `*URGENT:*` in the channel.

---

## 7. Inter-Agent Messaging

**Prerequisites:**

- Team mode enabled: `NOMOS_TEAM_MODE=true`
- Daemon running

**How to test:**

```bash
pnpm dev -- chat
```

```
/team Research the pros and cons of Bun vs Node.js, and also research Deno vs Node.js. Compare all three.
```

**Expected behavior:**

1. Coordinator decomposes into 2-3 worker subtasks
2. Workers can call `send_worker_message` to share findings with siblings
3. Workers can call `check_worker_messages` to read messages from coordinator
4. Final synthesized response includes all workers' results

**Manual verification (programmatic):**

```typescript
import { getTeamMailbox } from "./src/daemon/team-mailbox.ts";

const mailbox = getTeamMailbox();

// Worker 1 sends to coordinator
mailbox.sendFrom("worker-1", "coordinator", "Found 5 key differences", "normal");

// Worker 2 sends urgent
mailbox.sendFrom("worker-2", "coordinator", "Blocking issue: missing API", "blocking");

// Coordinator reads — blocking messages come first
const msgs = mailbox.receiveFor("coordinator");
console.log(msgs[0].priority); // "blocking"
console.log(msgs[1].priority); // "normal"

// Messages are consumed (not available again)
console.log(mailbox.hasPending("coordinator")); // false
```

---

## 8. Verification Agent

**Prerequisites:**

- Team mode enabled: `NOMOS_TEAM_MODE=true`
- Verification enabled in team config (set `verification: true` in team config or triggered by default for code-modifying tasks)

**How to test:**

```bash
pnpm dev -- chat
```

```
/team Add input validation to the cron scheduler's parseInterval function, and write tests for it.
```

**Expected behavior:**

1. Coordinator spawns worker(s) to implement the changes
2. After workers complete, a verification agent spawns automatically
3. Verification agent runs in `permissionMode: "plan"` (read-only)
4. Runs: `pnpm test`, `pnpm build`, `pnpm lint`
5. Reports structured result: `PASS`, `FAIL`, or `PARTIAL`
6. Coordinator includes verification results in the final synthesis

**What to look for in logs:**

```
[team] Spawning verification agent...
[team] Verification result: PASS — all 238 tests passing, build clean, no lint errors
```

---

## 9. Memory Consolidation

**Prerequisites:**

- Database with `memory_chunks` table populated (requires some prior conversations that were auto-indexed)
- For LLM phase: `ANTHROPIC_API_KEY` or equivalent provider configured

**How to test (CLI):**

```bash
pnpm dev -- chat
```

```
Run memory consolidation and show me the results.
```

**Expected:**

1. Agent calls `memory_consolidate`
2. Returns results:
   ```
   Memory consolidation complete:
     Merged: X duplicate chunks
     Pruned: Y stale chunks
     Rewritten: Z chunks (LLM review)
     Total: N → M chunks
   ```

**Verify each phase:**

1. **Prune** — chunks older than 7 days with access_count <= 1 are deleted (except `correction`/`skill` categories)
2. **Merge** — chunks with cosine similarity > 0.92 are merged (access counts combined, duplicate deleted)
3. **LLM review** — Haiku reviews batches of 20 chunks, decides KEEP/REWRITE/MERGE/DROP
4. **Decay** — user_model entries not updated in 30+ days get confidence reduced by 10%

**Check DB before/after:**

```sql
-- Before
SELECT count(*) FROM memory_chunks;
SELECT count(*) FROM user_model WHERE confidence > 0.1;

-- Run consolidation

-- After
SELECT count(*) FROM memory_chunks;
SELECT count(*) FROM user_model WHERE confidence > 0.1;
```

**As a scheduled task:**

```
Schedule memory consolidation to run every day at 3am.
```

Expected: Agent calls `schedule_task` with cron expression `0 3 * * *`.

---

## 10. Git Worktree Isolation

**Prerequisites:**

- Team mode enabled: `NOMOS_TEAM_MODE=true`
- Worktree isolation enabled (default for code-modifying team tasks)
- Project must be in a git repository

**How to test:**

```bash
pnpm dev -- chat
```

```
/team Implement a new utility function in src/utils/string-helpers.ts and also add tests for it in a separate file.
```

**Expected behavior:**

1. Each worker gets its own git worktree (`git worktree add`)
2. Workers operate in isolated directories (separate `cwd`)
3. After completion:
   - If worker made changes: worktree and branch preserved for review
   - If worker made no changes: worktree and branch auto-cleaned

**Verify worktrees during execution:**

```bash
# In another terminal while team is running
git worktree list
```

**Expected:** Shows temporary worktrees like:

```
/Users/you/project                   abc1234 [main]
/tmp/nomos-worktree-worker-1-xxxxx   def5678 [nomos-worker-1-xxxxx]
/tmp/nomos-worktree-worker-2-xxxxx   ghi9012 [nomos-worker-2-xxxxx]
```

**After completion (no changes):**

```bash
git worktree list   # Should show only the main worktree
git branch          # Temporary branches should be cleaned up
```

---

## 11. Historical Data Ingestion (P0a)

**Prerequisites:**

- Database with migrations applied (`pnpm dev -- db migrate`)
- For iMessage: macOS with Full Disk Access granted to terminal
- For Slack: Slack workspace configured with bot token

**How to test (CLI):**

```bash
# Dry run — preview without storing
pnpm dev -- ingest imessage --since 2024-01-01 --dry-run
```

**Expected:** Shows message count, contacts found, no data written.

**Full ingest:**

```bash
pnpm dev -- ingest imessage --since 2024-01-01
pnpm dev -- ingest status
```

**Expected:**

1. Messages chunked, embedded, stored in `memory_chunks` with `metadata->>'source' = 'ingest'`
2. `ingest_jobs` row with `status = 'completed'`, `messages_processed > 0`
3. Deduplication: re-running shows `messages_skipped` increase

**Slack ingest (sent messages only):**

```bash
pnpm dev -- ingest slack --since 2024-06-01
```

**Expected:** Only messages sent by the authenticated user are ingested.

**Verify DB:**

```sql
SELECT platform, status, messages_processed, messages_skipped FROM ingest_jobs;
```

---

## 12. Communication Style Model (P0b)

**Prerequisites:**

- Completed ingestion with sent messages

**How to test:**

```bash
pnpm dev -- ingest imessage --since 2024-01-01 --analyze-style
```

**Expected:**

1. Global style profile created (`contact_id IS NULL`)
2. Per-contact profiles for contacts with sufficient message volume
3. Profile contains: `formality` (1-5), `avg_length`, `emoji_usage`, `greeting_patterns`, `signoff_patterns`

**Verify DB:**

```sql
SELECT scope, sample_count, profile FROM style_profiles WHERE contact_id IS NULL;
SELECT c.display_name, sp.sample_count FROM style_profiles sp
  JOIN contacts c ON c.id = sp.contact_id ORDER BY sp.sample_count DESC;
```

---

## 13. Knowledge Wiki (P0c)

**Prerequisites:**

- Completed ingestion
- Daemon running (compiler runs via cron every 2h)

**How to test:**

Start the daemon and wait for the knowledge compiler cron, or verify after manual trigger.

**Expected:**

1. `wiki_articles` table populated with contact, topic, and style articles
2. Disk sync at `~/.nomos/wiki/` mirrors DB content
3. `_index.md` files contain summaries and backlinks

**Verify:**

```sql
SELECT path, title, category, word_count FROM wiki_articles ORDER BY compiled_at DESC;
```

```bash
ls ~/.nomos/wiki/contacts/
ls ~/.nomos/wiki/topics/
```

---

## 14. Cross-Channel Identity Graph (P1c)

**Prerequisites:**

- Completed ingestion from at least one platform

**How to test (CLI):**

```bash
pnpm dev -- contacts list
pnpm dev -- contacts show <contact-id>
```

**Expected:**

1. Contacts auto-created from ingested messages
2. `contact_identities` links platform user IDs to contacts
3. Auto-linker merges contacts with matching display names

**Manual linking:**

```bash
pnpm dev -- contacts link <contact-id> slack U12345678
pnpm dev -- contacts show <contact-id>   # shows both identities
pnpm dev -- contacts unlink <identity-id>
```

**Merge test:**

```bash
pnpm dev -- contacts merge <id1> <id2>
```

**Expected:** Identities from both contacts consolidated under one.

---

## 15. Email Channel (P1a)

**Prerequisites:**

- IMAP/SMTP credentials stored in `integrations` table (name: `email`)
- Daemon running

**How to test:**

Configure email integration via Settings UI (`/integrations/email`) or directly:

```sql
INSERT INTO integrations (name, enabled, config, secrets) VALUES (
  'email', true,
  '{"imap_host":"imap.gmail.com","imap_port":993,"smtp_host":"smtp.gmail.com","smtp_port":587}',
  '<encrypted>'
);
```

Start daemon: `pnpm dev -- daemon run`

**Expected:**

1. Logs show IMAP IDLE connection established
2. Incoming emails appear as messages in the daemon
3. Outgoing replies route through draft manager (approve-before-send)

---

## 16. Passive Observation Mode (P1b)

**Prerequisites:**

- Slack workspace configured
- Daemon running

**How to test:**

Configure observation channels:

```sql
INSERT INTO config (key, value) VALUES
  ('observe.slack-user:TEAM_ID.channels', '["C_CHANNEL_ID"]')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Start daemon and send messages in the observed channel.

**Expected:**

1. Messages indexed into memory (visible via `memory_search`)
2. Agent does NOT respond to observed messages
3. Style data extracted from observed patterns

---

## 17. Universal Draft-and-Approve (P2a)

**Prerequisites:**

- Contacts with different autonomy levels
- Daemon running with channel adapters

**How to test:**

Set autonomy levels:

```sql
UPDATE contacts SET autonomy = 'auto' WHERE display_name = 'Test Auto';
UPDATE contacts SET autonomy = 'draft' WHERE display_name = 'Test Draft';
UPDATE contacts SET autonomy = 'silent' WHERE display_name = 'Test Silent';
```

**Expected:**

- `auto` — messages sent immediately without draft
- `draft` — draft created for approval (`/drafts`, `/approve <id>`)
- `silent` — messages discarded, no draft created

---

## 18. Proactive Agency (P2b)

**Prerequisites:**

- Contacts and identity graph populated
- Daemon running with channel adapters
- Google Calendar configured (for meeting briefs)

**Commitment tracking:**

Have a conversation where commitments are made ("I'll send the report by Friday").

```sql
SELECT description, deadline, status FROM commitments ORDER BY created_at DESC;
```

**Expected:** Commitments extracted and tracked with deadlines.

**Meeting briefs:**

With Google Calendar configured, verify pre-meeting context generation includes attendee lookup from identity graph and recent conversation history.

**Priority triage:**

Verify cross-channel unread aggregation ranked by sender importance from contacts.

---

## 19. CATE Protocol Integration (P3)

**Prerequisites:**

- Daemon running

**How to test:**

```bash
pnpm dev -- daemon run
```

**Expected logs:**

```
[cate] Generated new agent key pair
[cate] Generated new user key pair
[cate] Transport listening on port 8801
[cate] Server started on port 8801 (DID: did:key:z6Mk...)
```

**Send test envelope:**

```bash
curl -X POST http://localhost:8801/cate \
  -H "Content-Type: application/json" \
  -d '{"header":{"msg_id":"test-1","created_at":"2026-04-07T00:00:00Z","sender":{"did":"did:key:z6MkTest"},"recipient":{"did":"did:key:z6MkTest2"}},"policy":{"intent":"personal"},"payload":{"content":"Hello"}}'
```

**Expected:** `{"status":"accepted"}` (200 OK)

**Verify keystore:**

```sql
SELECT name, config FROM integrations WHERE name LIKE 'cate-key:%';
```

**Expected:** `cate-key:nomos-agent` and `cate-key:nomos-user` with encrypted secrets.

---

## 20. Settings UI — New Pages

**Prerequisites:**

- Settings UI running: `cd settings && pnpm dev`

**Pages to verify:**

| Route              | What to check                                                |
| ------------------ | ------------------------------------------------------------ |
| `/setup`           | 6-step wizard (Data Sync is step 5)                          |
| `/admin/ingestion` | Per-platform sync status, counts, trigger sync, delta toggle |
| `/admin/proactive` | Commitment list, triage config, meeting brief settings       |

**Ingestion API:**

```bash
curl http://localhost:3456/api/ingestion
curl -X POST http://localhost:3456/api/ingestion -H "Content-Type: application/json" -d '{"platform":"imessage"}'
```

---

## Quick Smoke Test Checklist

Run through these in a single CLI session to verify everything works end-to-end:

```bash
pnpm dev -- chat
```

| #   | Command                                                                | Verifies             |
| --- | ---------------------------------------------------------------------- | -------------------- |
| 1   | `Navigate to https://example.com and take a screenshot`                | Browser automation   |
| 2   | `Close the browser`                                                    | Browser cleanup      |
| 3   | `Show running tasks`                                                   | Task state machine   |
| 4   | `Propose a plan to add logging to the daemon`                          | Plan mode            |
| 5   | `List all symbols in src/daemon/task-manager.ts using LSP`             | LSP document symbols |
| 6   | `Use LSP hover on line 66, character 14 of src/daemon/task-manager.ts` | LSP hover            |
| 7   | `Sleep for 5 seconds then tell me the current time`                    | Sleep/resume         |
| 8   | `Run memory consolidation`                                             | Memory consolidation |

For daemon-dependent features (run daemon first with `pnpm dev -- daemon run`):

| #   | Command                                         | Verifies                      |
| --- | ----------------------------------------------- | ----------------------------- |
| 9   | `Send a proactive message: "Test notification"` | Proactive messaging           |
| 10  | `/team List 3 pros and 3 cons of TypeScript`    | Teams + inter-agent messaging |

For digital clone features:

| #   | Command                                                    | Verifies            |
| --- | ---------------------------------------------------------- | ------------------- |
| 11  | `pnpm dev -- ingest imessage --since 2024-01-01 --dry-run` | Ingestion pipeline  |
| 12  | `pnpm dev -- ingest status`                                | Job tracking        |
| 13  | `pnpm dev -- contacts list`                                | Identity graph      |
| 14  | `curl -X POST localhost:8801/cate ...`                     | CATE protocol       |
| 15  | Visit `localhost:3456/admin/ingestion`                     | Ingestion dashboard |
| 16  | Visit `localhost:3456/setup`                               | 6-step wizard       |

---

## Automated Tests

Existing unit tests cover the core logic:

```bash
pnpm test                                    # All 249 tests
npx vitest run src/daemon/task-manager.ts    # Task manager
```

The full CI gate:

```bash
pnpm check    # format + typecheck + lint
pnpm test     # vitest
pnpm build    # tsdown build
```

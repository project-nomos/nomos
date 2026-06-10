---
name: autonomous-loops
description: "Create and manage your own autonomous loops -- recurring background jobs that run a prompt on a schedule (a daily briefing, a periodic check). Use this when you decide some work should happen on its own on a cadence, not just when asked. The user can always audit, disable, or delete loops you create."
emoji: "🔁"
---

# Autonomous Loops

An autonomous loop is a recurring job: a prompt that runs as your own agent turn on a schedule, with no user in the chat. The bundled loops live as `LOOP.md` files; the ones you create live as `cron_jobs` rows tagged `source = 'agent'` and owned by the current user. Either way, the cron engine fires them and the user can see and control them.

Reach for a loop when something genuinely benefits from happening on a cadence: a morning briefing, a weekly review of open commitments, a periodic sweep of a channel. Do not use a loop for one-off work (just do it now) or for anything time-critical (loops fire on a schedule, not instantly).

## Tools

You manage your own loops with these in-loop tools (no slash command needed):

- `loop_list` — see your loops, their schedules, and status. **Check this first** so you do not create a duplicate.
- `loop_create` — create a loop (name, description, schedule, prompt). Starts enabled by default.
- `loop_enable` / `loop_disable` — turn one of your loops on or off by name.
- `loop_update` — change a loop's schedule or prompt.
- `loop_delete` — remove one of your own (`source: 'agent'`) loops.

You can only manage loops you created. Bundled loops and ones the user made are theirs to change (via Settings or the CLI), so `loop_update`/`loop_delete` will refuse them.

## Writing a good loop

1. **Pick a clear, kebab-case name** that says what it does: `daily-standup-prep`, `weekly-commitment-review`.
2. **Choose a schedule.** Two forms:
   - **cron** (default): `"0 8 * * *"` = 8am daily, `"*/30 * * * *"` = every 30 min, `"0 9 * * 1-5"` = 9am weekdays.
   - **interval** (`scheduleType: "every"`): `"6h"`, `"1h"`, `"30m"`. The floor is 5 minutes; nothing more frequent.
     Schedule conservatively. A loop that fires every few minutes and usually has nothing to do is mostly noise and cost.
3. **Write the prompt as instructions to your future self** running with no user present. Be explicit about which tools to use and what to produce (write to memory, draft a message, etc.).
4. **End the prompt with the silent-run convention:** tell yourself to reply with exactly `AUTONOMOUS_OK` when there is nothing to do. That token is suppressed, so quiet runs stay quiet instead of pinging the user.
5. **Pick a delivery mode:** `none` (silent, the default — good for work that writes to memory) or `announce` (post the result to the default channel — good for a briefing the user should see).

## Example

```
loop_create(
  name: "weekly-commitment-review",
  description: "Review open commitments every Monday and flag anything slipping",
  schedule: "0 9 * * 1",
  prompt: "Review my open commitments. For each, check whether the deadline is near or past and whether there's been recent progress. Write a short 'Commitments — week of <date>' note to memory listing what needs attention. If nothing needs attention, reply with exactly AUTONOMOUS_OK.",
  deliveryMode: "announce"
)
```

## Responsible use

You have full autonomy to create and enable loops, bounded by a few guardrails, so use the judgment a careful colleague would:

- **Don't duplicate built-ins.** Memory consolidation (auto-dream), message triage, and meeting/calendar prep already run as first-class features. Check `loop_list` and prefer the built-in over a new loop that does the same thing.
- **Keep the set small.** There's a per-user cap (20 self-created loops). Prefer revising an existing loop (`loop_update`) over piling on new ones.
- **Schedule conservatively** and keep prompts narrow and well-scoped.
- **Stay transparent.** Everything you create is owned by the user and visible in Settings → Loops (and the iPhone app in hosted mode), where they can disable or delete it at any time. When you create a loop because of a conversation, tell the user you did and how to turn it off.

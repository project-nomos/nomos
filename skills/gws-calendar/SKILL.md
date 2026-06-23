---
name: gws-calendar
version: 1.0.0
description: "Google Calendar: Manage calendars and events."
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws"]
    cliHelp: "gws calendar --help"
---

# calendar (v3)

> **PREFER THE TYPED TOOLS.** When the in-process `calendar_*` MCP tools are available (`calendar_create_event`, `calendar_update_event`, `calendar_list_events`, `calendar_get_event`, `calendar_delete_event`), use them first — they're more reliable than the CLI. For a **recurring** event, call `calendar_create_event` with a `recurrence` arg (RRULE strings, e.g. `["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]`) — create ONE recurring event, never one per day. Pass an `account` arg to target a specific email. Use the CLI below only as a fallback for things the tools don't cover.

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, run `gws generate-skills` to create it.

```bash
gws calendar <resource> <method> [flags]
```

## Helper Commands

| Command                                      | Description                               |
| -------------------------------------------- | ----------------------------------------- |
| [`+insert`](../gws-calendar-insert/SKILL.md) | Create a new event                        |
| [`+agenda`](../gws-calendar-agenda/SKILL.md) | Show upcoming events across all calendars |

## API Resources

### calendarList

- `list` — Returns the calendars on the user's calendar list.
- `get` — Returns a calendar from the user's calendar list.
- `insert` — Inserts an existing calendar into the user's calendar list.
- `delete` — Removes a calendar from the user's calendar list.

### calendars

- `get` — Returns metadata for a calendar.
- `insert` — Creates a secondary calendar.
- `patch` — Updates metadata for a calendar (patch semantics).
- `delete` — Deletes a secondary calendar.
- `clear` — Clears a primary calendar (deletes all events).

### events

- `list` — Returns events on the specified calendar.
- `get` — Returns an event based on its Google Calendar ID.
- `insert` — Creates an event.
- `patch` — Updates an event (patch semantics).
- `delete` — Deletes an event.
- `move` — Moves an event to another calendar.
- `quickAdd` — Creates an event based on a simple text string.
- `instances` — Returns instances of a recurring event.
- `watch` — Watch for changes to Events resources.

### freebusy

- `query` — Returns free/busy information for a set of calendars.

### settings

- `list` — Returns all user settings for the authenticated user.
- `get` — Returns a single user setting.

## Discovering Commands

Before calling any API method, inspect it:

```bash
# Browse resources and methods
gws calendar --help

# Inspect a method's required params, types, and defaults
gws schema calendar.<resource>.<method>
```

Use `gws schema` output to build your `--params` and `--json` flags.

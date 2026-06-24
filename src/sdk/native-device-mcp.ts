/**
 * Native-device MCP — Calendar + Reminders tools that run on the user's CONNECTED
 * phone (EventKit), not in the daemon. Each tool routes through the device bridge
 * (`getDeviceBridge().invoke`), which pushes the call down the phone's open
 * `DeviceBridge` stream and awaits the result. When no phone is connected the call
 * fails cleanly so the agent can tell the user to open the app.
 *
 * Registered per-user, hosted-only, and only when a device is actually connected with
 * the matching capability (see agent-runtime). The agent never touches EventKit
 * directly — these tools are the only path, and the phone enforces its own permission
 * prompts, so the device stays in control of consent.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { getDeviceBridge, type DeviceResult } from "../daemon/device-bridge.ts";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Surface the phone's result: its JSON body on success, its error on failure. */
function present(r: DeviceResult, emptyNote: string) {
  if (!r.ok) return fail(r.error ?? "The device could not complete the request.");
  const body = (r.resultJson ?? "").trim();
  return ok(body.length > 0 ? body : emptyNote);
}

/** Build the per-user native-device MCP server (Calendar + Reminders over the bridge). */
export function buildNativeDeviceMcpServer(userId: string): McpSdkServerConfigWithInstance {
  const bridge = getDeviceBridge();
  const call = (toolName: string, args: unknown) =>
    bridge.invoke(userId, toolName, JSON.stringify(args));

  const calendarListEvents = tool(
    "calendar_list_events",
    "List events from the user's native iPhone Calendar within a date range. Runs on the user's connected phone via EventKit.",
    {
      startISO: z.string().describe("Start of the range, ISO 8601 (e.g. 2026-06-23T00:00:00Z)"),
      endISO: z.string().describe("End of the range, ISO 8601"),
    },
    async (args) => present(await call("calendar_list_events", args), "No events in that range."),
    { annotations: { readOnlyHint: true } },
  );

  const calendarCreateEvent = tool(
    "calendar_create_event",
    "Create an event in the user's native iPhone Calendar. Runs on the user's connected phone via EventKit. Confirm the details with the user first.",
    {
      title: z.string().describe("Event title"),
      startISO: z.string().describe("Event start, ISO 8601"),
      endISO: z.string().describe("Event end, ISO 8601"),
      location: z.string().optional().describe("Optional location"),
      notes: z.string().optional().describe("Optional notes"),
    },
    async (args) => present(await call("calendar_create_event", args), "Event created."),
  );

  const remindersList = tool(
    "reminders_list",
    "List the user's native iPhone Reminders, optionally from a named list. Runs on the user's connected phone via EventKit.",
    {
      listName: z
        .string()
        .optional()
        .describe("Optional Reminders list name; defaults to all lists"),
      includeCompleted: z
        .boolean()
        .optional()
        .describe("Include completed reminders (default false)"),
    },
    async (args) => present(await call("reminders_list", args), "No reminders found."),
    { annotations: { readOnlyHint: true } },
  );

  const remindersCreate = tool(
    "reminders_create",
    "Create a reminder in the user's native iPhone Reminders. Runs on the user's connected phone via EventKit.",
    {
      title: z.string().describe("Reminder title"),
      dueISO: z.string().optional().describe("Optional due date/time, ISO 8601"),
      notes: z.string().optional().describe("Optional notes"),
      listName: z.string().optional().describe("Optional Reminders list name"),
    },
    async (args) => present(await call("reminders_create", args), "Reminder created."),
  );

  const remindersComplete = tool(
    "reminders_complete",
    "Mark a native iPhone reminder complete by its id (from reminders_list). Runs on the user's connected phone via EventKit.",
    { id: z.string().describe("The reminder id returned by reminders_list") },
    async (args) => present(await call("reminders_complete", args), "Reminder completed."),
  );

  const contactsSearch = tool(
    "contacts_search",
    "Search the user's native iPhone Contacts (Address Book) by name. Returns matching contacts with phone numbers + emails. Runs on the user's connected phone.",
    { query: z.string().describe("Name (or part of a name) to search for") },
    async (args) => present(await call("contacts_search", args), "No matching contacts."),
    { annotations: { readOnlyHint: true } },
  );

  const contactsCreate = tool(
    "contacts_create",
    "Add a new contact to the user's native iPhone Contacts. Confirm the details with the user first.",
    {
      givenName: z.string().describe("First name"),
      familyName: z.string().optional().describe("Last name"),
      phone: z.string().optional().describe("Phone number"),
      email: z.string().optional().describe("Email address"),
    },
    async (args) => present(await call("contacts_create", args), "Contact added."),
  );

  const homeListAccessories = tool(
    "home_list_accessories",
    "List the HomeKit accessories in the user's home (lights, locks, thermostats, …) and their current on/off state. Runs on the user's connected phone.",
    {},
    async (args) =>
      present(await call("home_list_accessories", args), "No HomeKit accessories found."),
    { annotations: { readOnlyHint: true } },
  );

  const homeSetAccessory = tool(
    "home_set_accessory",
    "Turn a HomeKit accessory on or off by its name (from home_list_accessories). Runs on the user's connected phone.",
    {
      name: z.string().describe("The accessory name, e.g. 'Living Room Lamp'"),
      on: z.boolean().describe("true to turn on, false to turn off"),
    },
    async (args) => present(await call("home_set_accessory", args), "Done."),
  );

  return createSdkMcpServer({
    name: "nomos-native-device",
    version: "1.0.0",
    tools: [
      calendarListEvents,
      calendarCreateEvent,
      remindersList,
      remindersCreate,
      remindersComplete,
      contactsSearch,
      contactsCreate,
      homeListAccessories,
      homeSetAccessory,
    ],
  });
}

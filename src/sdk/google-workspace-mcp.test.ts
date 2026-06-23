import { describe, it, expect } from "vitest";
import { buildCalendarEventBody } from "./google-workspace-mcp.ts";

describe("buildCalendarEventBody", () => {
  const base = {
    summary: "Focus time",
    start: { dateTime: "2026-06-22T15:00:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-06-22T16:00:00", timeZone: "America/Los_Angeles" },
  };

  it("includes recurrence (RRULE) so a repeating event is ONE event, not one per day", () => {
    const body = buildCalendarEventBody({
      ...base,
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
    });
    expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]);
    expect(body.summary).toBe("Focus time");
  });

  it("omits recurrence for a one-off event (no empty array, no key)", () => {
    expect("recurrence" in buildCalendarEventBody(base)).toBe(false);
    expect("recurrence" in buildCalendarEventBody({ ...base, recurrence: [] })).toBe(false);
  });

  it("maps attendee emails to {email} objects and keeps optional fields conditional", () => {
    const body = buildCalendarEventBody({
      ...base,
      description: "deep work",
      attendees: ["a@x.com", "b@x.com"],
    });
    expect(body.attendees).toEqual([{ email: "a@x.com" }, { email: "b@x.com" }]);
    expect(body.description).toBe("deep work");
    expect("location" in body).toBe(false);
  });
});

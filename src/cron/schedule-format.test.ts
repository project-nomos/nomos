import { describe, it, expect } from "vitest";
import { prettifySchedule } from "./schedule-format.ts";

describe("prettifySchedule", () => {
  it("renders interval ('every') forms", () => {
    expect(prettifySchedule("1h", "every")).toBe("Hourly");
    expect(prettifySchedule("24h", "every")).toBe("Daily");
    expect(prettifySchedule("15m", "every")).toBe("Every 15 minutes");
    expect(prettifySchedule("2d", "every")).toBe("Every 2 days");
  });

  it("renders the friendly cron forms the consumer editor produces", () => {
    expect(prettifySchedule("0 9 * * *", "cron")).toBe("Daily at 9:00 AM");
    expect(prettifySchedule("30 17 * * 1-5", "cron")).toBe("Weekdays at 5:30 PM");
    expect(prettifySchedule("0 18 * * 1", "cron")).toBe("Weekly on Mon at 6:00 PM");
    expect(prettifySchedule("0 18 * * 1,3,5", "cron")).toBe("Weekly on Mon, Wed, Fri at 6:00 PM");
    expect(prettifySchedule("0 8 15 * *", "cron")).toBe("Monthly on day 15 at 8:00 AM");
  });

  it("treats Sunday as 0 or 7", () => {
    expect(prettifySchedule("0 9 * * 0", "cron")).toBe("Weekly on Sun at 9:00 AM");
    expect(prettifySchedule("0 9 * * 7", "cron")).toBe("Weekly on Sun at 9:00 AM");
  });

  it("falls back to the raw expression for unmappable cron", () => {
    expect(prettifySchedule("*/5 * * * *", "cron")).toBe("*/5 * * * *");
    expect(prettifySchedule("0 9 1 1 *", "cron")).toBe("0 9 1 1 *"); // specific month, not handled
  });

  it("renders one-off 'at' times", () => {
    expect(prettifySchedule("2026-06-18T09:00:00Z", "at").startsWith("Once,")).toBe(true);
    expect(prettifySchedule("not-a-date", "at")).toBe("not-a-date");
  });
});

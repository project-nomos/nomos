/**
 * Human-readable rendering of a cron_jobs schedule, shared by the consumer Loops
 * and Tasks surfaces. The wire `schedule` stays the raw string (clients edit it
 * and toggle/delete key off the id/name); this is display-only.
 */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function prettifySchedule(schedule: string, scheduleType: string): string {
  const s = schedule.trim();

  if (scheduleType === "every") {
    const m = s.match(/^(\d+)\s*([smhd])$/i);
    if (m) {
      const n = Number(m[1]);
      switch (m[2].toLowerCase()) {
        case "h":
          return n === 1 ? "Hourly" : n === 24 ? "Daily" : `Every ${n} hours`;
        case "m":
          return `Every ${n} minute${n === 1 ? "" : "s"}`;
        case "d":
          return n === 1 ? "Daily" : `Every ${n} days`;
        case "s":
          return `Every ${n} second${n === 1 ? "" : "s"}`;
      }
    }
    return `Every ${s}`;
  }

  if (scheduleType === "cron") {
    const parts = s.split(/\s+/);
    if (parts.length === 5) {
      const [min, hour, dom, mon, dow] = parts;
      if (/^\d+$/.test(min) && /^\d+$/.test(hour) && mon === "*") {
        const clock = formatClock(Number(hour), min);
        if (dom === "*" && dow === "*") return `Daily at ${clock}`;
        if (dom === "*" && dow === "1-5") return `Weekdays at ${clock}`;
        if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
          const names = dow
            .split(",")
            .map((d) => DOW[Number(d) === 7 ? 0 : Number(d)])
            .join(", ");
          return `Weekly on ${names} at ${clock}`;
        }
        if (dow === "*" && /^\d+$/.test(dom)) return `Monthly on day ${dom} at ${clock}`;
      }
    }
    return s;
  }

  if (scheduleType === "at") {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return `Once, ${d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }
    return s;
  }

  return s;
}

function formatClock(hour: number, min: string): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${min.padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

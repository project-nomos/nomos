"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Bell,
  CheckCircle2,
  Clock,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface Commitment {
  id: string;
  description: string;
  deadline: string | null;
  status: string;
  reminded: boolean;
  created_at: string;
}

type InboxAutonomy = "off" | "passive" | "active" | "aggressive";
type BriefingDays = "everyday" | "weekdays" | "custom";

/**
 * Parse a cron expression into a (time, days) pair if it matches our
 * supported simple patterns. Returns `null` for unsupported expressions
 * (the UI then falls back to a raw text input).
 */
function parseBriefingCron(cron: string): { time: string; days: BriefingDays } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  const m = parseInt(min, 10);
  const h = parseInt(hour, 10);
  if (m > 59 || h > 23) return null;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dow === "*") return { time, days: "everyday" };
  if (dow === "1-5") return { time, days: "weekdays" };
  return null;
}

function formatBriefingCron(time: string, days: BriefingDays): string {
  const [hStr, mStr] = time.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const dow = days === "weekdays" ? "1-5" : "*";
  return `${m} ${h} * * ${dow}`;
}

const AUTONOMY_OPTIONS: Array<{ value: InboxAutonomy; label: string; description: string }> = [
  { value: "off", label: "Off", description: "No automatic inbox or calendar work." },
  { value: "passive", label: "Passive", description: "Summarize urgent items only. No drafts." },
  {
    value: "active",
    label: "Active",
    description: "Summarize + stage reply drafts for your approval.",
  },
  {
    value: "aggressive",
    label: "Aggressive",
    description: "Auto-send low-stakes replies (RSVPs, confirms). Drafts for anything ambiguous.",
  },
];

export default function ProactivePage() {
  const [enabled, setEnabled] = useState(false);
  const [autonomy, setAutonomy] = useState<InboxAutonomy>("off");
  const [briefingCron, setBriefingCron] = useState("0 8 * * *");
  const [inboxInterval, setInboxInterval] = useState("15m");
  const [calendarInterval, setCalendarInterval] = useState("5m");
  const [savingAutonomy, setSavingAutonomy] = useState(false);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      // Fetch proactive config
      const configRes = await fetch("/api/config");
      const configData = await configRes.json();
      if (configData.config) {
        const get = (k: string) =>
          configData.config.find((c: { key: string }) => c.key === k)?.value;

        const proactiveVal = get("app.proactiveEnabled");
        setEnabled(proactiveVal === "true" || proactiveVal === true);

        const autonomyVal = get("app.inboxAutonomy");
        if (typeof autonomyVal === "string") setAutonomy(autonomyVal as InboxAutonomy);

        const cronVal = get("app.briefingCron");
        if (typeof cronVal === "string" && cronVal) setBriefingCron(cronVal);

        const inboxVal = get("app.inboxScanInterval");
        if (typeof inboxVal === "string" && inboxVal) setInboxInterval(inboxVal);

        const calVal = get("app.calendarScanInterval");
        if (typeof calVal === "string" && calVal) setCalendarInterval(calVal);
      }

      // Fetch commitments from DB
      const dbRes = await fetch("/api/admin/database/table?name=commitments&limit=20");
      const dbData = await dbRes.json();
      if (dbData.rows) {
        setCommitments(dbData.rows);
      }
    } catch {
      // Table might not exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleEnabled = async () => {
    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "app.proactiveEnabled",
          value: enabled ? "false" : "true",
        }),
      });
      setEnabled(!enabled);
      addToast(`Proactive features ${enabled ? "disabled" : "enabled"}`, "success");
    } catch {
      addToast("Failed to toggle", "error");
    }
  };

  const saveAutonomyConfig = async (next: {
    autonomy?: InboxAutonomy;
    briefingCron?: string;
    inboxInterval?: string;
    calendarInterval?: string;
  }) => {
    setSavingAutonomy(true);
    try {
      const body: Record<string, string> = {};
      if (next.autonomy !== undefined) body["app.inboxAutonomy"] = next.autonomy;
      if (next.briefingCron !== undefined) body["app.briefingCron"] = next.briefingCron;
      if (next.inboxInterval !== undefined) body["app.inboxScanInterval"] = next.inboxInterval;
      if (next.calendarInterval !== undefined)
        body["app.calendarScanInterval"] = next.calendarInterval;

      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("save failed");

      // Re-register cron jobs in the running daemon.
      await fetch("/api/admin/proactive/reload", { method: "POST" }).catch(() => {});

      addToast("Inbox autonomy saved", "success");
    } catch {
      addToast("Failed to save", "error");
    } finally {
      setSavingAutonomy(false);
    }
  };

  const handleAutonomyChange = (value: InboxAutonomy) => {
    setAutonomy(value);
    void saveAutonomyConfig({ autonomy: value });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const pendingCommitments = commitments.filter((c) => c.status === "pending");
  const completedCommitments = commitments.filter((c) => c.status === "completed");

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Proactive Features</h1>
          <p className="text-sm text-gray-400 mt-1">
            Commitment tracking, meeting briefs, and priority triage
          </p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={toggleEnabled}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition"
          >
            {enabled ? (
              <ToggleRight className="w-6 h-6 text-green-400" />
            ) : (
              <ToggleLeft className="w-6 h-6" />
            )}
            {enabled ? "Enabled" : "Disabled"}
          </button>
          <button
            onClick={fetchData}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-sm transition"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {!enabled && (
        <div className="p-4 rounded-xl border border-yellow-500/20 bg-yellow-500/5">
          <p className="text-sm text-yellow-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Proactive features are disabled. Enable them to start tracking commitments and
            generating triage summaries.
          </p>
        </div>
      )}

      {/* Inbox / calendar autonomy */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Inbox & Calendar Autonomy</h2>
          <p className="text-xs text-gray-400 mt-1">
            Controls how aggressively the agent handles Gmail and Calendar. Results post to your
            default notification channel. Requires Google Workspace to be connected.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {AUTONOMY_OPTIONS.map((opt) => {
            const selected = autonomy === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => handleAutonomyChange(opt.value)}
                disabled={savingAutonomy}
                className={`text-left rounded-lg border p-3 transition ${
                  selected
                    ? "border-blue-400/60 bg-blue-400/10"
                    : "border-white/10 bg-white/[0.02] hover:bg-white/5"
                } disabled:opacity-50`}
              >
                <div
                  className={`text-sm font-semibold ${selected ? "text-blue-200" : "text-white"}`}
                >
                  {opt.label}
                </div>
                <div className="text-xs text-gray-400 mt-1 leading-snug">{opt.description}</div>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
          <BriefingScheduleControl
            value={briefingCron}
            disabled={savingAutonomy || autonomy === "off"}
            onChange={(next) => {
              setBriefingCron(next);
              void saveAutonomyConfig({ briefingCron: next });
            }}
          />

          <label className="text-xs text-gray-400 flex flex-col gap-1">
            <span>Inbox scan interval</span>
            <input
              type="text"
              value={inboxInterval}
              onChange={(e) => setInboxInterval(e.target.value)}
              onBlur={() => saveAutonomyConfig({ inboxInterval })}
              placeholder="15m"
              disabled={savingAutonomy || autonomy === "off"}
              className="rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white font-mono disabled:opacity-50 focus:outline-none focus:border-blue-400/60"
            />
            <span className="text-[10px] text-gray-500">E.g. 5m, 15m, 1h.</span>
          </label>

          <label className="text-xs text-gray-400 flex flex-col gap-1">
            <span>Calendar scan interval</span>
            <input
              type="text"
              value={calendarInterval}
              onChange={(e) => setCalendarInterval(e.target.value)}
              onBlur={() => saveAutonomyConfig({ calendarInterval })}
              placeholder="5m"
              disabled={savingAutonomy || autonomy === "off"}
              className="rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white font-mono disabled:opacity-50 focus:outline-none focus:border-blue-400/60"
            />
            <span className="text-[10px] text-gray-500">
              Briefs meetings starting in roughly this window.
            </span>
          </label>
        </div>

        {autonomy === "off" && (
          <p className="text-xs text-gray-500">Select a level above to register the cron jobs.</p>
        )}
      </div>

      {/* Feature cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <Bell className="w-5 h-5 text-blue-400 mb-2" />
          <h3 className="font-semibold text-white text-sm">Commitment Tracking</h3>
          <p className="text-xs text-gray-400 mt-1">
            Extracts promises and follow-ups from conversations. Reminds you before deadlines.
          </p>
          <div className="mt-3 text-lg font-bold text-white">{pendingCommitments.length}</div>
          <div className="text-xs text-gray-500">pending commitments</div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <Clock className="w-5 h-5 text-purple-400 mb-2" />
          <h3 className="font-semibold text-white text-sm">Meeting Briefs</h3>
          <p className="text-xs text-gray-400 mt-1">
            Pre-meeting context with attendee history and suggested agenda items.
          </p>
          <div className="mt-3 text-xs text-gray-500">
            Triggered automatically before calendar events
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <CheckCircle2 className="w-5 h-5 text-green-400 mb-2" />
          <h3 className="font-semibold text-white text-sm">Priority Triage</h3>
          <p className="text-xs text-gray-400 mt-1">
            Daily summary of unread messages ranked by importance and urgency.
          </p>
          <div className="mt-3 text-xs text-gray-500">Delivered daily via configured channels</div>
        </div>
      </div>

      {/* Commitments list */}
      {pendingCommitments.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-white">Pending Commitments</h2>
          {pendingCommitments.map((c) => (
            <div key={c.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-white">{c.description}</p>
                  {c.deadline && (
                    <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Due: {new Date(c.deadline).toLocaleDateString()}
                    </p>
                  )}
                </div>
                {c.reminded && (
                  <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">
                    Reminded
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {completedCommitments.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-white text-opacity-50">
            Completed ({completedCommitments.length})
          </h2>
          {completedCommitments.slice(0, 5).map((c) => (
            <div
              key={c.id}
              className="rounded-xl border border-white/5 bg-white/[0.02] p-3 opacity-60"
            >
              <p className="text-sm text-gray-400 line-through">{c.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BriefingScheduleControl({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (cron: string) => void;
}) {
  const parsed = parseBriefingCron(value);

  // `forceCustom` lets the user opt into the raw-cron input even when the
  // current value would parse cleanly (e.g., they want monthly schedules).
  const [forceCustom, setForceCustom] = useState(false);
  const isCustom = parsed === null || forceCustom;

  // Local state for the raw-cron textbox so typing doesn't fire onChange
  // on every keystroke. Commits on blur.
  const [rawCron, setRawCron] = useState(value);
  useEffect(() => setRawCron(value), [value]);

  // Defaults for the simple controls when the existing value is custom.
  const time = parsed?.time ?? "08:00";
  const days: BriefingDays = parsed?.days ?? "everyday";

  const inputClass =
    "rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-sm text-white disabled:opacity-50 focus:outline-none focus:border-blue-400/60";

  const handleDaysChange = (next: string) => {
    if (next === "custom") {
      setForceCustom(true);
      return;
    }
    onChange(formatBriefingCron(time, next as BriefingDays));
  };

  return (
    <div className="text-xs text-gray-400 flex flex-col gap-1 sm:col-span-1">
      <span>Morning briefing</span>

      {!isCustom && (
        <div className="flex gap-2">
          <input
            type="time"
            value={time}
            onChange={(e) => onChange(formatBriefingCron(e.target.value || "08:00", days))}
            disabled={disabled}
            className={`${inputClass} flex-1`}
          />
          <select
            value={days}
            onChange={(e) => handleDaysChange(e.target.value)}
            disabled={disabled}
            className={`${inputClass} flex-1`}
          >
            <option value="everyday">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
      )}

      {isCustom && (
        <div className="flex flex-col gap-1">
          <input
            type="text"
            value={rawCron}
            onChange={(e) => setRawCron(e.target.value)}
            onBlur={() => {
              if (rawCron !== value) onChange(rawCron);
            }}
            placeholder="0 8 * * *"
            disabled={disabled}
            className={`${inputClass} font-mono`}
          />
          <button
            type="button"
            onClick={() => {
              setForceCustom(false);
              if (!parseBriefingCron(rawCron)) {
                onChange("0 8 * * *");
              }
            }}
            disabled={disabled}
            className="text-[10px] text-blue-400 hover:text-blue-300 text-left disabled:opacity-50"
          >
            ← back to simple picker
          </button>
        </div>
      )}

      <span className="text-[10px] text-gray-500">
        {isCustom ? "Custom cron expression." : "Daily push to your default channel."}
      </span>
    </div>
  );
}

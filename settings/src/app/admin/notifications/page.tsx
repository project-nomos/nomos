"use client";

import { useEffect, useState, useCallback } from "react";
import { Bell } from "lucide-react";

interface Target {
  platform: string;
  channelId: string;
  label?: string;
}
interface Draft {
  platform: string;
  channelId: string;
  label: string;
}

const emptyDraft = (t: Target | null): Draft => ({
  platform: t?.platform ?? "",
  channelId: t?.channelId ?? "",
  label: t?.label ?? "",
});

export default function NotificationsAdminPage() {
  const [owners, setOwners] = useState<string[]>([]);
  const [globalTarget, setGlobalTarget] = useState<Target | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Target | null>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [ownersRes, global] = await Promise.all([
      fetch("/api/owners").then((r) => r.json()),
      fetch("/api/notifications").then((r) => r.json()),
    ]);
    const list: string[] = ownersRes.owners ?? ["local"];
    const map: Record<string, Target | null> = {};
    const d: Record<string, Draft> = {};
    await Promise.all(
      list.map(async (uid) => {
        const t = (await fetch(`/api/notifications?userId=${encodeURIComponent(uid)}`).then((r) =>
          r.json(),
        )) as Target | null;
        map[uid] = t;
        d[uid] = emptyDraft(t);
      }),
    );
    setOwners(list);
    setGlobalTarget(global);
    setOverrides(map);
    setDrafts(d);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setField = (uid: string, field: keyof Draft, value: string) =>
    setDrafts((d) => ({ ...d, [uid]: { ...d[uid], [field]: value } }));

  const save = async (uid: string) => {
    const dft = drafts[uid];
    if (!dft.platform || !dft.channelId) {
      setStatus("Platform and channel are required.");
      return;
    }
    const res = await fetch(`/api/notifications?userId=${encodeURIComponent(uid)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dft),
    });
    setStatus(res.ok ? `Saved override for ${uid}.` : "Save failed.");
    await load();
  };

  const clear = async (uid: string) => {
    await fetch(`/api/notifications?userId=${encodeURIComponent(uid)}`, { method: "DELETE" });
    setStatus(`Cleared override for ${uid}; it now inherits the global default.`);
    await load();
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-2 flex items-center gap-2">
        <Bell className="h-5 w-5 text-mauve" />
        <h1 className="text-lg font-semibold text-text">Notification targets</h1>
      </div>
      <p className="mb-6 text-sm text-overlay0">
        Where proactive deliveries (commitment reminders, the triage digest) are sent. Each owner
        falls back to the global default unless it has an override below — useful in a hosted
        multi-member instance where each member wants their own channel.
      </p>

      <section className="mb-6 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-subtext1">
          Global default
        </h2>
        {globalTarget ? (
          <p className="text-sm text-text">
            {globalTarget.label ?? `${globalTarget.platform} / ${globalTarget.channelId}`}
            <span className="ml-2 text-xs text-overlay0">
              ({globalTarget.platform}:{globalTarget.channelId})
            </span>
          </p>
        ) : (
          <p className="text-sm text-peach">Not set. Configure it on the Slack integration page.</p>
        )}
      </section>

      {status && <p className="mb-4 text-sm text-green">{status}</p>}

      {loading ? (
        <p className="text-sm text-overlay0">Loading owners…</p>
      ) : (
        <div className="space-y-4">
          {owners.map((uid) => (
            <section key={uid} className="rounded-xl border border-surface0 bg-mantle p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium text-text">{uid}</h3>
                <span className="text-xs text-overlay0">
                  {overrides[uid] ? "per-owner override" : "inherits global default"}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input
                  placeholder="platform (e.g. slack)"
                  value={drafts[uid]?.platform ?? ""}
                  onChange={(e) => setField(uid, "platform", e.target.value)}
                  className="rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:border-mauve focus:outline-none"
                />
                <input
                  placeholder="channel / DM id"
                  value={drafts[uid]?.channelId ?? ""}
                  onChange={(e) => setField(uid, "channelId", e.target.value)}
                  className="rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:border-mauve focus:outline-none"
                />
                <input
                  placeholder="label (optional)"
                  value={drafts[uid]?.label ?? ""}
                  onChange={(e) => setField(uid, "label", e.target.value)}
                  className="rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:border-mauve focus:outline-none"
                />
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => save(uid)}
                  className="rounded-lg bg-mauve px-3 py-1.5 text-sm font-medium text-crust hover:opacity-90"
                >
                  Save override
                </button>
                {overrides[uid] && (
                  <button
                    onClick={() => clear(uid)}
                    className="rounded-lg border border-surface1 px-3 py-1.5 text-sm text-subtext1 hover:bg-surface0"
                  >
                    Clear
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

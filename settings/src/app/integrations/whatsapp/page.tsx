"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { DirtyIndicator } from "@/components/dirty-indicator";
import { useToast } from "@/contexts/toast-context";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

export default function WhatsAppSettingsPage() {
  const { addToast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [initialEnabled, setInitialEnabled] = useState(false);
  const [allowedChats, setAllowedChats] = useState("");
  const [initialAllowedChats, setInitialAllowedChats] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isDirty = enabled !== initialEnabled || allowedChats !== initialAllowedChats;
  useUnsavedChanges(isDirty);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, envRes] = await Promise.all([fetch("/api/status"), fetch("/api/env")]);
      const statusData = await statusRes.json();
      const envData = await envRes.json();

      const isEnabled = statusData.whatsapp?.configured ?? false;
      setEnabled(isEnabled);
      setInitialEnabled(isEnabled);

      const chats = envData.WHATSAPP_ALLOWED_CHATS ?? "";
      setAllowedChats(chats);
      setInitialAllowedChats(chats);
    } catch (err) {
      console.error("Failed to load WhatsApp data:", err);
      addToast("Failed to load WhatsApp data", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const save = async () => {
    if (!isDirty) return;
    setSaving(true);
    try {
      const updates: Record<string, string> = {};
      if (enabled !== initialEnabled) {
        updates.WHATSAPP_ENABLED = enabled ? "true" : "";
      }
      if (allowedChats !== initialAllowedChats) {
        updates.WHATSAPP_ALLOWED_CHATS = allowedChats;
      }

      const res = await fetch("/api/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const data = await res.json();
        addToast(data.error ?? "Failed to save", "error");
        return;
      }

      addToast("WhatsApp settings saved", "success");
      await loadData();
    } catch (err) {
      console.error("Failed to save WhatsApp settings:", err);
      addToast("Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-2xl font-bold text-text">WhatsApp</h1>
        <DirtyIndicator isDirty={isDirty} />
      </div>
      <p className="text-sm text-overlay0 mb-8">Configure WhatsApp integration</p>

      {/* Connection Status */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connection Status
        </h2>
        <div className="flex items-center justify-between">
          <span className="text-sm text-text">WhatsApp</span>
          <StatusBadge
            status={enabled ? "connected" : "not_configured"}
            label={enabled ? "Enabled" : "Disabled"}
          />
        </div>
      </section>

      {/* Enable/Disable */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Integration
        </h2>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-mauve w-4 h-4 rounded"
          />
          <div>
            <span className="text-sm font-medium text-text">Enable WhatsApp</span>
            <p className="text-xs text-overlay0">
              Uses QR code authentication via Baileys. Scan the QR code when the daemon starts.
            </p>
          </div>
        </label>
      </section>

      {/* Access Control */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Access Control
        </h2>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-subtext1">Allowed Chats</label>
          <input
            type="text"
            value={allowedChats}
            onChange={(e) => setAllowedChats(e.target.value)}
            placeholder="user@s.whatsapp.net, group@g.us"
            className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
          />
          <p className="text-xs text-overlay0">
            Comma-separated JIDs. Use @s.whatsapp.net for users, @g.us for groups. Leave empty to
            allow all.
          </p>
        </div>
      </section>

      {/* Save */}
      <button
        onClick={save}
        disabled={saving || !isDirty}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving && <RefreshCw size={14} className="animate-spin" />}
        Save
      </button>
    </div>
  );
}

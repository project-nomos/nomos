"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import { TokenInput } from "@/components/token-input";
import { StatusBadge } from "@/components/status-badge";
import { DirtyIndicator } from "@/components/dirty-indicator";
import { useToast } from "@/contexts/toast-context";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

export default function TelegramSettingsPage() {
  const { addToast } = useToast();
  const [botToken, setBotToken] = useState("");
  const [hasBotToken, setHasBotToken] = useState(false);
  const [botTokenDirty, setBotTokenDirty] = useState(false);
  const [allowedChats, setAllowedChats] = useState("");
  const [initialAllowedChats, setInitialAllowedChats] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isDirty = botTokenDirty || allowedChats !== initialAllowedChats;
  useUnsavedChanges(isDirty);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, envRes] = await Promise.all([fetch("/api/status"), fetch("/api/env")]);
      const statusData = await statusRes.json();
      const envData = await envRes.json();

      setHasBotToken(statusData.telegram?.botToken ?? false);
      setBotToken("");
      setBotTokenDirty(false);

      const chats = envData.TELEGRAM_ALLOWED_CHATS ?? "";
      setAllowedChats(chats);
      setInitialAllowedChats(chats);
    } catch (err) {
      console.error("Failed to load Telegram data:", err);
      addToast("Failed to load Telegram data", "error");
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
      if (botTokenDirty) updates.TELEGRAM_BOT_TOKEN = botToken;
      if (allowedChats !== initialAllowedChats) {
        updates.TELEGRAM_ALLOWED_CHATS = allowedChats;
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

      addToast("Telegram settings saved", "success");
      await loadData();
    } catch (err) {
      console.error("Failed to save Telegram settings:", err);
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
        <h1 className="text-2xl font-bold text-text">Telegram</h1>
        <DirtyIndicator isDirty={isDirty} />
      </div>
      <div className="flex items-center gap-3 mb-8">
        <p className="text-sm text-overlay0">Configure Telegram bot integration</p>
        <div className="flex items-center gap-2">
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
          >
            @BotFather <ExternalLink size={10} />
          </a>
          <span className="text-overlay0">·</span>
          <a
            href="https://core.telegram.org/bots/tutorial"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
          >
            Setup Guide <ExternalLink size={10} />
          </a>
        </div>
      </div>

      {/* Connection Status */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connection Status
        </h2>
        <div className="flex items-center justify-between">
          <span className="text-sm text-text">Bot Token</span>
          <StatusBadge
            status={hasBotToken ? "connected" : "not_configured"}
            label={hasBotToken ? "Configured" : "Not set"}
          />
        </div>
      </section>

      {/* Bot Token */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Bot Token
        </h2>
        <TokenInput
          label="Telegram Bot Token"
          value={botToken}
          onChange={(v) => {
            setBotToken(v);
            setBotTokenDirty(true);
          }}
          placeholder={
            hasBotToken ? "Configured - enter new value to replace" : "123456:ABC-DEF..."
          }
          helperText="Get a token from @BotFather on Telegram"
        />
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
            placeholder="chat-id-1, chat-id-2"
            className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
          />
          <p className="text-xs text-overlay0">
            Comma-separated chat IDs. Leave empty to allow all.
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
        Save to .env
      </button>
    </div>
  );
}

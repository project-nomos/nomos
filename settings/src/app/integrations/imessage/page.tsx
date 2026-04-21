"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, ExternalLink, CheckCircle, XCircle, Shield, Eye } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { SyncProgress } from "@/components/sync-progress";
import { DirtyIndicator } from "@/components/dirty-indicator";
import { useToast } from "@/contexts/toast-context";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

type IMessageMode = "chatdb" | "bluebubbles";
type AgentMode = "passive" | "agent";

export default function IMessageSettingsPage() {
  const { addToast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [initialEnabled, setInitialEnabled] = useState(false);
  const [mode, setMode] = useState<IMessageMode>("chatdb");
  const [initialMode, setInitialMode] = useState<IMessageMode>("chatdb");
  const [agentMode, setAgentMode] = useState<AgentMode>("passive");
  const [initialAgentMode, setInitialAgentMode] = useState<AgentMode>("passive");
  const [allowedChats, setAllowedChats] = useState("");
  const [initialAllowedChats, setInitialAllowedChats] = useState("");

  // Owner identity for agent mode
  const [ownerPhone, setOwnerPhone] = useState("");
  const [initialOwnerPhone, setInitialOwnerPhone] = useState("");
  const [ownerAppleId, setOwnerAppleId] = useState("");
  const [initialOwnerAppleId, setInitialOwnerAppleId] = useState("");

  // BlueBubbles-specific
  const [bbServerUrl, setBbServerUrl] = useState("");
  const [initialBbServerUrl, setInitialBbServerUrl] = useState("");
  const [bbPassword, setBbPassword] = useState("");
  const [initialBbPassword, setInitialBbPassword] = useState("");
  const [bbWebhookPort, setBbWebhookPort] = useState("8803");
  const [initialBbWebhookPort, setInitialBbWebhookPort] = useState("8803");
  const [bbReadReceipts, setBbReadReceipts] = useState(false);
  const [initialBbReadReceipts, setInitialBbReadReceipts] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pingResult, setPingResult] = useState<boolean | null>(null);
  const [pinging, setPinging] = useState(false);

  const isDirty =
    enabled !== initialEnabled ||
    mode !== initialMode ||
    agentMode !== initialAgentMode ||
    allowedChats !== initialAllowedChats ||
    ownerPhone !== initialOwnerPhone ||
    ownerAppleId !== initialOwnerAppleId ||
    bbServerUrl !== initialBbServerUrl ||
    bbPassword !== initialBbPassword ||
    bbWebhookPort !== initialBbWebhookPort ||
    bbReadReceipts !== initialBbReadReceipts;
  useUnsavedChanges(isDirty);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, envRes] = await Promise.all([fetch("/api/status"), fetch("/api/env")]);
      const statusData = await statusRes.json();
      const envData = await envRes.json();

      const isEnabled = statusData.imessage?.configured ?? envData.IMESSAGE_ENABLED === "true";
      setEnabled(isEnabled);
      setInitialEnabled(isEnabled);

      const m = (envData.IMESSAGE_MODE as IMessageMode) || "chatdb";
      setMode(m);
      setInitialMode(m);

      const am = (envData.IMESSAGE_AGENT_MODE as AgentMode) || "passive";
      setAgentMode(am);
      setInitialAgentMode(am);

      const chats = envData.IMESSAGE_ALLOWED_CHATS ?? "";
      setAllowedChats(chats);
      setInitialAllowedChats(chats);

      const phone = envData.IMESSAGE_OWNER_PHONE ?? "";
      setOwnerPhone(phone);
      setInitialOwnerPhone(phone);

      const appleId = envData.IMESSAGE_OWNER_APPLE_ID ?? "";
      setOwnerAppleId(appleId);
      setInitialOwnerAppleId(appleId);

      const url = envData.BLUEBUBBLES_SERVER_URL ?? "";
      setBbServerUrl(url);
      setInitialBbServerUrl(url);

      const pw = envData.BLUEBUBBLES_PASSWORD ?? "";
      setBbPassword(pw);
      setInitialBbPassword(pw);

      const port = envData.BLUEBUBBLES_WEBHOOK_PORT ?? "8803";
      setBbWebhookPort(port);
      setInitialBbWebhookPort(port);

      const rr = envData.BLUEBUBBLES_READ_RECEIPTS === "true";
      setBbReadReceipts(rr);
      setInitialBbReadReceipts(rr);
    } catch (err) {
      console.error("Failed to load iMessage data:", err);
      addToast("Failed to load Messages.app data", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const testConnection = async () => {
    if (!bbServerUrl || !bbPassword) {
      addToast("Server URL and password are required", "error");
      return;
    }
    setPinging(true);
    setPingResult(null);
    try {
      const res = await fetch(
        `${bbServerUrl}/api/v1/ping?password=${encodeURIComponent(bbPassword)}`,
      );
      setPingResult(res.ok);
      addToast(
        res.ok ? "Connected to BlueBubbles" : "Connection failed",
        res.ok ? "success" : "error",
      );
    } catch {
      setPingResult(false);
      addToast("Cannot reach BlueBubbles server", "error");
    } finally {
      setPinging(false);
    }
  };

  const save = async () => {
    if (!isDirty) return;

    // Validate agent mode requires at least one owner identity
    if (enabled && agentMode === "agent" && !ownerPhone && !ownerAppleId) {
      addToast("Agent mode requires at least a phone number or Apple ID", "error");
      return;
    }

    setSaving(true);
    try {
      const updates: Record<string, string> = {};

      if (enabled !== initialEnabled) updates.IMESSAGE_ENABLED = enabled ? "true" : "";
      if (mode !== initialMode) updates.IMESSAGE_MODE = mode;
      if (agentMode !== initialAgentMode) updates.IMESSAGE_AGENT_MODE = agentMode;
      if (allowedChats !== initialAllowedChats) updates.IMESSAGE_ALLOWED_CHATS = allowedChats;
      if (ownerPhone !== initialOwnerPhone) updates.IMESSAGE_OWNER_PHONE = ownerPhone;
      if (ownerAppleId !== initialOwnerAppleId) updates.IMESSAGE_OWNER_APPLE_ID = ownerAppleId;
      if (bbServerUrl !== initialBbServerUrl) updates.BLUEBUBBLES_SERVER_URL = bbServerUrl;
      if (bbPassword !== initialBbPassword) updates.BLUEBUBBLES_PASSWORD = bbPassword;
      if (bbWebhookPort !== initialBbWebhookPort) updates.BLUEBUBBLES_WEBHOOK_PORT = bbWebhookPort;
      if (bbReadReceipts !== initialBbReadReceipts)
        updates.BLUEBUBBLES_READ_RECEIPTS = bbReadReceipts ? "true" : "";

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

      addToast("Messages.app settings saved", "success");
      await loadData();
      // Auto-trigger ingestion for iMessage
      fetch("/api/ingestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "imessage", action: "trigger-ingest" }),
      }).catch(() => {});
    } catch (err) {
      console.error("Failed to save iMessage settings:", err);
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
        <h1 className="text-2xl font-bold text-text">Messages.app</h1>
        <DirtyIndicator isDirty={isDirty} />
      </div>
      <div className="flex items-center gap-3 mb-8">
        <p className="text-sm text-overlay0">Configure Messages.app integration</p>
        <a
          href="https://github.com/project-nomos/nomos/blob/main/docs/integrations/imessage.md"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
        >
          Setup Guide <ExternalLink size={10} />
        </a>
      </div>

      {/* Connection Status */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connection Status
        </h2>
        <div className="flex items-center justify-between">
          <span className="text-sm text-text">Messages.app</span>
          <StatusBadge
            status={enabled ? "connected" : "not_configured"}
            label={
              enabled
                ? `Enabled (${mode === "bluebubbles" ? "BlueBubbles" : "chat.db"} / ${agentMode})`
                : "Disabled"
            }
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
            <span className="text-sm font-medium text-text">Enable Messages.app</span>
            <p className="text-xs text-overlay0">
              Connect to Messages.app via local database or BlueBubbles server.
            </p>
          </div>
        </label>
      </section>

      {/* Agent Mode Selector */}
      {enabled && (
        <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
            Agent Mode
          </h2>
          <div className="space-y-3">
            <label
              className={`flex items-start gap-3 cursor-pointer p-3 rounded-lg border transition-colors ${
                agentMode === "passive"
                  ? "border-mauve/50 bg-mauve/5"
                  : "border-surface1 hover:border-mauve/50"
              }`}
            >
              <input
                type="radio"
                name="agent-mode"
                value="passive"
                checked={agentMode === "passive"}
                onChange={() => setAgentMode("passive")}
                className="accent-mauve mt-0.5"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Eye size={14} className="text-blue" />
                  <span className="text-sm font-medium text-text">Passive</span>
                </div>
                <p className="text-xs text-overlay0 mt-1">
                  Listens to all incoming messages, drafts responses, and suggests them in your
                  default Slack channel for approval before sending. Safe for monitoring
                  conversations without risking unintended replies.
                </p>
              </div>
            </label>

            <label
              className={`flex items-start gap-3 cursor-pointer p-3 rounded-lg border transition-colors ${
                agentMode === "agent"
                  ? "border-mauve/50 bg-mauve/5"
                  : "border-surface1 hover:border-mauve/50"
              }`}
            >
              <input
                type="radio"
                name="agent-mode"
                value="agent"
                checked={agentMode === "agent"}
                onChange={() => setAgentMode("agent")}
                className="accent-mauve mt-0.5"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Shield size={14} className="text-green" />
                  <span className="text-sm font-medium text-text">Agent Client</span>
                </div>
                <p className="text-xs text-overlay0 mt-1">
                  Chat directly with the agent via Messages.app. Only responds to messages from your
                  phone number and Apple ID -- all other messages are ignored. Use this to interact
                  with your agent from your iPhone.
                </p>
              </div>
            </label>
          </div>
        </section>
      )}

      {/* Owner Identity (agent mode only) */}
      {enabled && agentMode === "agent" && (
        <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
            Owner Identity
          </h2>
          <p className="text-xs text-overlay0 mb-4">
            In agent mode, only messages from these identifiers will be processed. At least one is
            required.
          </p>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Phone Number</label>
              <input
                type="text"
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value)}
                placeholder="+15551234567"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
              />
              <p className="text-xs text-overlay0">
                Your phone number in international format (e.g., +1 for US).
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Apple ID</label>
              <input
                type="text"
                value={ownerAppleId}
                onChange={(e) => setOwnerAppleId(e.target.value)}
                placeholder="you@icloud.com"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
              />
              <p className="text-xs text-overlay0">
                Your Apple ID email address used for iMessage.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Connection Mode */}
      {enabled && (
        <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
            Connection Mode
          </h2>
          <div className="space-y-3">
            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-surface1 hover:border-mauve/50 transition-colors">
              <input
                type="radio"
                name="imessage-mode"
                value="chatdb"
                checked={mode === "chatdb"}
                onChange={() => setMode("chatdb")}
                className="accent-mauve mt-0.5"
              />
              <div>
                <span className="text-sm font-medium text-text">Local chat.db</span>
                <p className="text-xs text-overlay0 mt-0.5">
                  Reads directly from ~/Library/Messages/chat.db and sends via AppleScript. Zero
                  setup, but macOS-only. Requires Full Disk Access.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-surface1 hover:border-mauve/50 transition-colors">
              <input
                type="radio"
                name="imessage-mode"
                value="bluebubbles"
                checked={mode === "bluebubbles"}
                onChange={() => setMode("bluebubbles")}
                className="accent-mauve mt-0.5"
              />
              <div>
                <span className="text-sm font-medium text-text">BlueBubbles Server</span>
                <p className="text-xs text-overlay0 mt-0.5">
                  Connects to a BlueBubbles macOS server via REST API + webhooks. Supports sending,
                  reactions, typing indicators, and read receipts. Works cross-platform.
                </p>
                <a
                  href="https://bluebubbles.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80 mt-1"
                >
                  bluebubbles.app <ExternalLink size={10} />
                </a>
              </div>
            </label>
          </div>
        </section>
      )}

      {/* BlueBubbles Config */}
      {enabled && mode === "bluebubbles" && (
        <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
            BlueBubbles Server
          </h2>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Server URL</label>
              <input
                type="text"
                value={bbServerUrl}
                onChange={(e) => setBbServerUrl(e.target.value)}
                placeholder="http://192.168.1.100:1234"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
              />
              <p className="text-xs text-overlay0">
                The URL of your BlueBubbles server (e.g., http://your-mac-ip:1234).
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Server Password</label>
              <input
                type="password"
                value={bbPassword}
                onChange={(e) => setBbPassword(e.target.value)}
                placeholder="BlueBubbles server password"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
              />
              <p className="text-xs text-overlay0">
                Found in BlueBubbles &gt; Settings &gt; API/Web Settings.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Webhook Port</label>
              <input
                type="text"
                value={bbWebhookPort}
                onChange={(e) => setBbWebhookPort(e.target.value)}
                placeholder="8803"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono max-w-32"
              />
              <p className="text-xs text-overlay0">
                Port for receiving webhooks from BlueBubbles (default: 8803).
              </p>
            </div>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={bbReadReceipts}
                onChange={(e) => setBbReadReceipts(e.target.checked)}
                className="accent-mauve w-4 h-4 rounded"
              />
              <div>
                <span className="text-sm font-medium text-text">Send read receipts</span>
                <p className="text-xs text-overlay0">Mark messages as read when processed.</p>
              </div>
            </label>

            {/* Test Connection */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={testConnection}
                disabled={pinging || !bbServerUrl || !bbPassword}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 bg-surface0 text-sm text-text hover:border-mauve/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pinging && <RefreshCw size={14} className="animate-spin" />}
                Test Connection
              </button>
              {pingResult !== null && (
                <span className="inline-flex items-center gap-1 text-sm">
                  {pingResult ? (
                    <>
                      <CheckCircle size={14} className="text-green" />
                      <span className="text-green">Connected</span>
                    </>
                  ) : (
                    <>
                      <XCircle size={14} className="text-red" />
                      <span className="text-red">Failed</span>
                    </>
                  )}
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Access Control (passive mode -- filter which chats to listen to) */}
      {enabled && agentMode === "passive" && (
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
              placeholder="+15551234567, user@example.com, chat123456789"
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
            />
            <p className="text-xs text-overlay0">
              Comma-separated phone numbers, emails, or chat identifiers. Leave empty to listen to
              all conversations.
            </p>
          </div>
        </section>
      )}

      {/* Sync Progress */}
      {enabled && <SyncProgress platform="imessage" />}

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

"use client";

import { useEffect, useState, useCallback } from "react";
import {
  RefreshCw,
  ExternalLink,
  CheckCircle,
  XCircle,
  Shield,
  Eye,
  AlertTriangle,
} from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { DirtyIndicator } from "@/components/dirty-indicator";
import { useToast } from "@/contexts/toast-context";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

type FeatureMode = "basic" | "advanced";
type AgentMode = "passive" | "agent";

export default function IMessageSettingsPage() {
  const { addToast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [initialEnabled, setInitialEnabled] = useState(false);
  const [featureMode, setFeatureMode] = useState<FeatureMode>("basic");
  const [initialFeatureMode, setInitialFeatureMode] = useState<FeatureMode>("basic");
  const [agentMode, setAgentMode] = useState<AgentMode>("passive");
  const [initialAgentMode, setInitialAgentMode] = useState<AgentMode>("passive");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [initialOwnerPhone, setInitialOwnerPhone] = useState("");
  const [ownerAppleId, setOwnerAppleId] = useState("");
  const [initialOwnerAppleId, setInitialOwnerAppleId] = useState("");

  const [imsgInstalled, setImsgInstalled] = useState<boolean | null>(null);
  const [imsgVersion, setImsgVersion] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isDirty =
    enabled !== initialEnabled ||
    featureMode !== initialFeatureMode ||
    agentMode !== initialAgentMode ||
    ownerPhone !== initialOwnerPhone ||
    ownerAppleId !== initialOwnerAppleId;
  useUnsavedChanges(isDirty);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, envRes] = await Promise.all([fetch("/api/status"), fetch("/api/env")]);
      const statusData = await statusRes.json();
      const envData = await envRes.json();

      const isEnabled = statusData.imessage?.configured ?? envData.IMESSAGE_ENABLED === "true";
      setEnabled(isEnabled);
      setInitialEnabled(isEnabled);

      const fm = (envData.IMESSAGE_FEATURE_MODE as FeatureMode) || "basic";
      setFeatureMode(fm);
      setInitialFeatureMode(fm);

      const am = (envData.IMESSAGE_AGENT_MODE as AgentMode) || "passive";
      setAgentMode(am);
      setInitialAgentMode(am);

      const phone = envData.IMESSAGE_OWNER_PHONE ?? "";
      setOwnerPhone(phone);
      setInitialOwnerPhone(phone);

      const appleId = envData.IMESSAGE_OWNER_APPLE_ID ?? "";
      setOwnerAppleId(appleId);
      setInitialOwnerAppleId(appleId);

      // Check if imsg CLI is installed (server-side check via status)
      setImsgInstalled(statusData.imessage?.imsgInstalled ?? null);
      setImsgVersion(statusData.imessage?.imsgVersion ?? "");
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

  const save = async () => {
    if (!isDirty) return;

    if (enabled && agentMode === "agent" && !ownerPhone && !ownerAppleId) {
      addToast("Agent mode requires at least a phone number or Apple ID", "error");
      return;
    }

    setSaving(true);
    try {
      const updates: Record<string, string> = {};

      if (enabled !== initialEnabled) updates.IMESSAGE_ENABLED = enabled ? "true" : "";
      if (featureMode !== initialFeatureMode) updates.IMESSAGE_FEATURE_MODE = featureMode;
      if (agentMode !== initialAgentMode) updates.IMESSAGE_AGENT_MODE = agentMode;
      if (ownerPhone !== initialOwnerPhone) updates.IMESSAGE_OWNER_PHONE = ownerPhone;
      if (ownerAppleId !== initialOwnerAppleId) updates.IMESSAGE_OWNER_APPLE_ID = ownerAppleId;

      if (Object.keys(updates).length === 0) {
        setSaving(false);
        return;
      }

      const res = await fetch("/api/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(await res.text());

      setInitialEnabled(enabled);
      setInitialFeatureMode(featureMode);
      setInitialAgentMode(agentMode);
      setInitialOwnerPhone(ownerPhone);
      setInitialOwnerAppleId(ownerAppleId);
      addToast("Messages.app settings saved", "success");
    } catch (err) {
      console.error(err);
      addToast("Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin" size={24} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-2xl font-bold text-text">Messages.app (iMessage)</h1>
          <p className="text-sm text-overlay0 mt-1">
            Read, watch, and send iMessages via the <code className="text-mauve">imsg</code> CLI.
          </p>
        </div>
        <StatusBadge
          status={enabled && imsgInstalled === true ? "connected" : "not_configured"}
          label={enabled ? (imsgInstalled ? "Active" : "imsg not installed") : "Disabled"}
        />
      </div>

      {/* imsg CLI status */}
      <section className="mt-6 mb-6 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-3">
          imsg CLI
        </h2>
        {imsgInstalled === true ? (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle size={16} className="text-green" />
            <span className="text-text">Installed</span>
            {imsgVersion && <span className="text-overlay0 font-mono text-xs">{imsgVersion}</span>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <XCircle size={16} className="text-red" />
              <span className="text-text">Not installed</span>
            </div>
            <div className="rounded-lg bg-base/50 border border-surface0 p-3">
              <p className="text-xs text-subtext0 mb-2">Install with Homebrew:</p>
              <code className="block text-xs font-mono text-mauve">
                brew install steipete/tap/imsg
              </code>
            </div>
            <a
              href="https://github.com/openclaw/imsg"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
            >
              imsg docs <ExternalLink size={10} />
            </a>
          </div>
        )}
      </section>

      {/* Enable toggle */}
      <section className="mb-6 rounded-xl border border-surface0 bg-mantle p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text">Enable Messages.app integration</h2>
            <p className="text-xs text-overlay0 mt-0.5">
              Watch chat.db for new messages and send via Messages.app.
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-surface1 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-overlay0 after:transition-all after:content-[''] peer-checked:bg-mauve peer-checked:after:translate-x-full peer-checked:after:bg-crust" />
          </label>
        </div>
      </section>

      {enabled && (
        <>
          {/* Feature mode */}
          <section className="mb-6 rounded-xl border border-surface0 bg-mantle p-5">
            <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-3">
              Feature Mode
            </h2>
            <div className="space-y-2">
              <label
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  featureMode === "basic"
                    ? "border-mauve/50 bg-mauve/5"
                    : "border-surface0 bg-base hover:border-surface1"
                }`}
              >
                <input
                  type="radio"
                  name="featureMode"
                  value="basic"
                  checked={featureMode === "basic"}
                  onChange={() => setFeatureMode("basic")}
                  className="accent-mauve mt-0.5"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Shield size={14} className="text-green" />
                    <span className="text-sm font-medium text-text">Basic (recommended)</span>
                  </div>
                  <p className="text-xs text-overlay0 mt-1">
                    Read messages, send text and files, standard tapbacks (👍❤️😂‼️❓👎). No system
                    modifications needed.
                  </p>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  featureMode === "advanced"
                    ? "border-peach/50 bg-peach/5"
                    : "border-surface0 bg-base hover:border-surface1"
                }`}
              >
                <input
                  type="radio"
                  name="featureMode"
                  value="advanced"
                  checked={featureMode === "advanced"}
                  onChange={() => setFeatureMode("advanced")}
                  className="accent-peach mt-0.5"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-peach" />
                    <span className="text-sm font-medium text-text">
                      Advanced (requires SIP disabled)
                    </span>
                  </div>
                  <p className="text-xs text-overlay0 mt-1">
                    Adds: edit, unsend, typing indicators, effects, custom emoji reactions, group
                    management.
                  </p>
                  {featureMode === "advanced" && (
                    <div className="mt-3 rounded-lg bg-peach/10 border border-peach/30 p-3">
                      <p className="text-xs text-peach font-semibold mb-2 flex items-center gap-1">
                        <AlertTriangle size={12} />
                        Security trade-off
                      </p>
                      <p className="text-xs text-subtext0 leading-relaxed mb-2">
                        Advanced features require disabling System Integrity Protection (SIP), which
                        removes a core macOS security boundary. Only do this if you understand the
                        implications.
                      </p>
                      <ol className="text-xs text-subtext0 list-decimal list-inside space-y-0.5">
                        <li>Boot into Recovery Mode (hold ⌘R on startup)</li>
                        <li>
                          Open Terminal and run: <code className="text-mauve">csrutil disable</code>
                        </li>
                        <li>Reboot normally</li>
                        <li>
                          Run: <code className="text-mauve">imsg launch</code>
                        </li>
                      </ol>
                    </div>
                  )}
                </div>
              </label>
            </div>
          </section>

          {/* Agent mode */}
          <section className="mb-6 rounded-xl border border-surface0 bg-mantle p-5">
            <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-3">
              Agent Mode
            </h2>
            <div className="space-y-2">
              <label
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  agentMode === "passive"
                    ? "border-mauve/50 bg-mauve/5"
                    : "border-surface0 bg-base hover:border-surface1"
                }`}
              >
                <input
                  type="radio"
                  name="agentMode"
                  value="passive"
                  checked={agentMode === "passive"}
                  onChange={() => setAgentMode("passive")}
                  className="accent-mauve mt-0.5"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <Eye size={14} className="text-blue" />
                    <span className="text-sm font-medium text-text">Passive (default)</span>
                  </div>
                  <p className="text-xs text-overlay0 mt-1">
                    Watch all conversations, draft responses for your approval before sending.
                  </p>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  agentMode === "agent"
                    ? "border-mauve/50 bg-mauve/5"
                    : "border-surface0 bg-base hover:border-surface1"
                }`}
              >
                <input
                  type="radio"
                  name="agentMode"
                  value="agent"
                  checked={agentMode === "agent"}
                  onChange={() => setAgentMode("agent")}
                  className="accent-mauve mt-0.5"
                />
                <div>
                  <span className="text-sm font-medium text-text">Agent (owner only)</span>
                  <p className="text-xs text-overlay0 mt-1">
                    Only respond to messages from you. Acts as a personal agent client.
                  </p>
                </div>
              </label>
            </div>

            {agentMode === "agent" && (
              <div className="mt-4 space-y-3 pt-4 border-t border-surface0">
                <div>
                  <label className="block text-xs font-medium text-subtext1 mb-1">
                    Owner Phone (with country code)
                  </label>
                  <input
                    type="tel"
                    value={ownerPhone}
                    onChange={(e) => setOwnerPhone(e.target.value)}
                    placeholder="+15551234567"
                    className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-subtext1 mb-1">
                    Owner Apple ID
                  </label>
                  <input
                    type="email"
                    value={ownerAppleId}
                    onChange={(e) => setOwnerAppleId(e.target.value)}
                    placeholder="you@icloud.com"
                    className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
                  />
                </div>
              </div>
            )}
          </section>

          {/* Permissions reminder */}
          <section className="mb-6 rounded-xl border border-surface0 bg-mantle p-5">
            <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-3">
              macOS Permissions Required
            </h2>
            <ul className="text-xs text-subtext0 space-y-1.5 list-disc list-inside">
              <li>
                <strong>Full Disk Access</strong> for your terminal (to read chat.db)
              </li>
              <li>
                <strong>Automation</strong> permission for Messages.app (to send)
              </li>
              <li>
                <strong>Contacts</strong> permission (optional, for name resolution)
              </li>
            </ul>
          </section>
        </>
      )}

      {/* Save button */}
      <div className="flex items-center justify-end gap-3 sticky bottom-4 mt-6">
        <DirtyIndicator isDirty={isDirty} />
        <button
          onClick={save}
          disabled={!isDirty || saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40"
        >
          {saving ? <RefreshCw size={14} className="animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

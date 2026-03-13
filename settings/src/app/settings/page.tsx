"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { TokenInput } from "@/components/token-input";
import { DirtyIndicator } from "@/components/dirty-indicator";
import { useToast } from "@/contexts/toast-context";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

const MODELS = [
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const PERMISSION_MODES = [
  { value: "default", label: "Default", description: "Ask before running tools" },
  { value: "acceptEdits", label: "Accept Edits", description: "Auto-approve file edits, ask for others" },
  { value: "plan", label: "Plan", description: "Plan mode - propose changes before applying" },
  { value: "bypassPermissions", label: "Bypass", description: "Auto-approve all tool calls" },
];

const VERTEX_REGIONS = [
  "us-east5",
  "us-central1",
  "europe-west1",
  "europe-west4",
  "asia-southeast1",
];

export default function AssistantSettingsPage() {
  const { addToast } = useToast();

  // Identity (DB config)
  const [agentName, setAgentName] = useState("");
  const [initialAgentName, setInitialAgentName] = useState("");
  const [agentEmoji, setAgentEmoji] = useState("");
  const [initialAgentEmoji, setInitialAgentEmoji] = useState("");
  const [agentPurpose, setAgentPurpose] = useState("");
  const [initialAgentPurpose, setInitialAgentPurpose] = useState("");

  // Env-based settings
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [initialModel, setInitialModel] = useState("claude-sonnet-4-6");
  const [permissionMode, setPermissionMode] = useState("default");
  const [initialPermissionMode, setInitialPermissionMode] = useState("default");
  const [daemonPort, setDaemonPort] = useState("8765");
  const [initialDaemonPort, setInitialDaemonPort] = useState("8765");

  // Vertex AI / GCP
  const [useVertex, setUseVertex] = useState(false);
  const [initialUseVertex, setInitialUseVertex] = useState(false);
  const [gcpProject, setGcpProject] = useState("");
  const [initialGcpProject, setInitialGcpProject] = useState("");
  const [gcpRegion, setGcpRegion] = useState("us-east5");
  const [initialGcpRegion, setInitialGcpRegion] = useState("us-east5");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const isIdentityDirty =
    agentName !== initialAgentName ||
    agentEmoji !== initialAgentEmoji ||
    agentPurpose !== initialAgentPurpose;

  const isEnvDirty =
    apiKeyDirty ||
    model !== initialModel ||
    permissionMode !== initialPermissionMode ||
    daemonPort !== initialDaemonPort ||
    useVertex !== initialUseVertex ||
    gcpProject !== initialGcpProject ||
    gcpRegion !== initialGcpRegion;

  const isDirty = isIdentityDirty || isEnvDirty;
  useUnsavedChanges(isDirty);

  const loadData = useCallback(async () => {
    try {
      const [envRes, configRes] = await Promise.all([
        fetch("/api/env"),
        fetch("/api/config"),
      ]);
      const envData = await envRes.json();
      const configData = await configRes.json();

      setHasApiKey(!!envData.ANTHROPIC_API_KEY);
      setApiKey("");
      setApiKeyDirty(false);

      const m = envData.NOMOS_MODEL ?? "claude-sonnet-4-6";
      setModel(m);
      setInitialModel(m);

      const pm = envData.NOMOS_PERMISSION_MODE ?? "default";
      setPermissionMode(pm);
      setInitialPermissionMode(pm);

      const dp = envData.DAEMON_PORT ?? "8765";
      setDaemonPort(dp);
      setInitialDaemonPort(dp);

      const vertex = envData.CLAUDE_CODE_USE_VERTEX === "1" || envData.CLAUDE_CODE_USE_VERTEX === "true";
      setUseVertex(vertex);
      setInitialUseVertex(vertex);

      const proj = envData.GOOGLE_CLOUD_PROJECT ?? "";
      setGcpProject(proj);
      setInitialGcpProject(proj);

      const region = envData.CLOUD_ML_REGION ?? "us-east5";
      setGcpRegion(region);
      setInitialGcpRegion(region);

      // Identity from config
      const name = (configData["agent.name"] as string) ?? "";
      setAgentName(name);
      setInitialAgentName(name);

      const emoji = (configData["agent.emoji"] as string) ?? "";
      setAgentEmoji(emoji);
      setInitialAgentEmoji(emoji);

      const purpose = (configData["agent.purpose"] as string) ?? "";
      setAgentPurpose(purpose);
      setInitialAgentPurpose(purpose);
    } catch (err) {
      console.error("Failed to load settings:", err);
      addToast("Failed to load settings", "error");
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
      const promises: Promise<Response>[] = [];

      // Save identity to config API
      if (isIdentityDirty) {
        const configUpdates: Record<string, string> = {};
        if (agentName !== initialAgentName) configUpdates["agent.name"] = agentName;
        if (agentEmoji !== initialAgentEmoji) configUpdates["agent.emoji"] = agentEmoji;
        if (agentPurpose !== initialAgentPurpose) configUpdates["agent.purpose"] = agentPurpose;

        promises.push(
          fetch("/api/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(configUpdates),
          }),
        );
      }

      // Save env settings
      if (isEnvDirty) {
        const envUpdates: Record<string, string> = {};
        if (apiKeyDirty) envUpdates.ANTHROPIC_API_KEY = apiKey;
        if (model !== initialModel) envUpdates.NOMOS_MODEL = model;
        if (permissionMode !== initialPermissionMode) envUpdates.NOMOS_PERMISSION_MODE = permissionMode;
        if (daemonPort !== initialDaemonPort) envUpdates.DAEMON_PORT = daemonPort;
        if (useVertex !== initialUseVertex) envUpdates.CLAUDE_CODE_USE_VERTEX = useVertex ? "1" : "";
        if (gcpProject !== initialGcpProject) envUpdates.GOOGLE_CLOUD_PROJECT = gcpProject;
        if (gcpRegion !== initialGcpRegion) envUpdates.CLOUD_ML_REGION = gcpRegion;

        promises.push(
          fetch("/api/env", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(envUpdates),
          }),
        );
      }

      const results = await Promise.all(promises);
      const failed = results.find((r) => !r.ok);
      if (failed) {
        const data = await failed.json();
        addToast(data.error ?? "Failed to save settings", "error");
        return;
      }

      addToast("Settings saved successfully", "success");
      await loadData();
    } catch (err) {
      console.error("Failed to save settings:", err);
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
        <h1 className="text-2xl font-bold text-text">Assistant</h1>
        <DirtyIndicator isDirty={isDirty} />
      </div>
      <p className="text-sm text-overlay0 mb-8">
        Personality, model selection, and configuration
      </p>

      {/* Identity / Personality */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Identity
        </h2>
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="flex-1 space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Name</label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="Nomos"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
              />
            </div>
            <div className="w-24 space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Emoji</label>
              <input
                type="text"
                value={agentEmoji}
                onChange={(e) => setAgentEmoji(e.target.value)}
                placeholder="🤖"
                maxLength={4}
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text text-center placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-subtext1">Purpose</label>
            <textarea
              value={agentPurpose}
              onChange={(e) => setAgentPurpose(e.target.value)}
              placeholder="A helpful AI assistant that..."
              rows={3}
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 resize-none"
            />
            <p className="text-xs text-overlay0">
              Defines your assistant's core role and how it approaches problems
            </p>
          </div>
        </div>
      </section>

      {/* API Configuration */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Anthropic API
        </h2>
        <TokenInput
          label="API Key"
          value={apiKey}
          onChange={(v) => { setApiKey(v); setApiKeyDirty(true); }}
          placeholder={hasApiKey ? "Configured - enter new value to replace" : "sk-ant-..."}
          helperText="Required for Anthropic direct API access. Not needed if using Vertex AI."
        />
      </section>

      {/* Google Cloud / Vertex AI */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider">
            Google Cloud / Vertex AI
          </h2>
          <a
            href="https://console.cloud.google.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
          >
            GCP Console <ExternalLink size={10} />
          </a>
        </div>
        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useVertex}
              onChange={(e) => setUseVertex(e.target.checked)}
              className="accent-mauve w-4 h-4 rounded"
            />
            <div>
              <span className="text-sm font-medium text-text">Use Vertex AI</span>
              <p className="text-xs text-overlay0">Route requests through Google Cloud Vertex AI instead of the Anthropic API</p>
            </div>
          </label>
          {useVertex && (
            <>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-subtext1">
                  GCP Project ID
                </label>
                <input
                  type="text"
                  value={gcpProject}
                  onChange={(e) => setGcpProject(e.target.value)}
                  placeholder="my-project-12345"
                  className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-subtext1">
                  Region
                </label>
                <select
                  value={gcpRegion}
                  onChange={(e) => setGcpRegion(e.target.value)}
                  className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
                >
                  {VERTEX_REGIONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <p className="text-xs text-overlay0">
                  Requires <code className="text-xs bg-surface0 px-1 rounded">gcloud auth application-default login</code> for authentication
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Model Selection */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Model
        </h2>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-subtext1">
            Default Model
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Advanced Settings (collapsible) */}
      <div className="mb-8">
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="flex items-center gap-2 text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4 hover:text-text transition-colors"
        >
          {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Advanced Settings
        </button>

        {advancedOpen && (
          <div className="space-y-8">
            {/* Permission Mode */}
            <section className="rounded-xl border border-surface0 bg-mantle p-5">
              <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
                Permission Mode
              </h2>
              <div className="space-y-2">
                {PERMISSION_MODES.map((pm) => (
                  <label
                    key={pm.value}
                    className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                      permissionMode === pm.value
                        ? "border-mauve/50 bg-mauve/5"
                        : "border-surface0 bg-base hover:border-surface1"
                    }`}
                  >
                    <input
                      type="radio"
                      name="permissionMode"
                      value={pm.value}
                      checked={permissionMode === pm.value}
                      onChange={(e) => setPermissionMode(e.target.value)}
                      className="accent-mauve"
                    />
                    <div>
                      <span className="text-sm font-medium text-text">
                        {pm.label}
                      </span>
                      <p className="text-xs text-overlay0">{pm.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </section>

            {/* Daemon */}
            <section className="rounded-xl border border-surface0 bg-mantle p-5">
              <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
                Daemon
              </h2>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-subtext1">
                  WebSocket Port
                </label>
                <input
                  type="number"
                  value={daemonPort}
                  onChange={(e) => setDaemonPort(e.target.value)}
                  placeholder="8765"
                  className="w-full max-w-xs rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
                />
                <p className="text-xs text-overlay0">Port for daemon WebSocket server (default: 8765)</p>
              </div>
            </section>
          </div>
        )}
      </div>

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

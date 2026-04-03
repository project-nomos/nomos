"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { TokenInput } from "@/components/token-input";
import { EmojiPicker } from "@/components/emoji-picker";
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
  {
    value: "acceptEdits",
    label: "Accept Edits",
    description: "Auto-approve file edits, ask for others",
  },
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

  // Personality (SOUL)
  const [agentSoul, setAgentSoul] = useState("");
  const [initialAgentSoul, setInitialAgentSoul] = useState("");

  // API provider
  const [apiProvider, setApiProvider] = useState("anthropic");
  const [initialApiProvider, setInitialApiProvider] = useState("anthropic");

  // Env-based settings
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [hasOpenrouterApiKey, setHasOpenrouterApiKey] = useState(false);
  const [openrouterApiKeyDirty, setOpenrouterApiKeyDirty] = useState(false);
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [initialModel, setInitialModel] = useState("claude-sonnet-4-6");
  const [permissionMode, setPermissionMode] = useState("default");
  const [initialPermissionMode, setInitialPermissionMode] = useState("default");
  const [daemonPort, setDaemonPort] = useState("8765");
  const [initialDaemonPort, setInitialDaemonPort] = useState("8765");

  // Vertex AI / GCP
  const [gcpProject, setGcpProject] = useState("");
  const [initialGcpProject, setInitialGcpProject] = useState("");
  const [gcpRegion, setGcpRegion] = useState("us-east5");
  const [initialGcpRegion, setInitialGcpRegion] = useState("us-east5");

  // Smart model routing
  const [smartRouting, setSmartRouting] = useState(false);
  const [initialSmartRouting, setInitialSmartRouting] = useState(false);
  const [modelSimple, setModelSimple] = useState("claude-haiku-4-5");
  const [initialModelSimple, setInitialModelSimple] = useState("claude-haiku-4-5");
  const [modelModerate, setModelModerate] = useState("claude-sonnet-4-6");
  const [initialModelModerate, setInitialModelModerate] = useState("claude-sonnet-4-6");
  const [modelComplex, setModelComplex] = useState("claude-sonnet-4-6");
  const [initialModelComplex, setInitialModelComplex] = useState("claude-sonnet-4-6");

  // Custom API endpoint
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState("");
  const [initialAnthropicBaseUrl, setInitialAnthropicBaseUrl] = useState("");

  // Multi-agent teams
  const [teamMode, setTeamMode] = useState(false);
  const [initialTeamMode, setInitialTeamMode] = useState(false);
  const [maxTeamWorkers, setMaxTeamWorkers] = useState("4");
  const [initialMaxTeamWorkers, setInitialMaxTeamWorkers] = useState("4");

  // Adaptive memory
  const [adaptiveMemory, setAdaptiveMemory] = useState(true);
  const [initialAdaptiveMemory, setInitialAdaptiveMemory] = useState(true);
  const [extractionModel, setExtractionModel] = useState("claude-haiku-4-5");
  const [initialExtractionModel, setInitialExtractionModel] = useState("claude-haiku-4-5");

  // Image generation
  const [imageGeneration, setImageGeneration] = useState(false);
  const [initialImageGeneration, setInitialImageGeneration] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [hasGeminiApiKey, setHasGeminiApiKey] = useState(false);
  const [geminiApiKeyDirty, setGeminiApiKeyDirty] = useState(false);
  const [imageGenerationModel, setImageGenerationModel] = useState("gemini-3-pro-image-preview");
  const [initialImageGenerationModel, setInitialImageGenerationModel] = useState(
    "gemini-3-pro-image-preview",
  );

  // Video generation
  const [videoGeneration, setVideoGeneration] = useState(false);
  const [initialVideoGeneration, setInitialVideoGeneration] = useState(false);
  const [videoGenerationModel, setVideoGenerationModel] = useState("veo-3.0-generate-preview");
  const [initialVideoGenerationModel, setInitialVideoGenerationModel] = useState(
    "veo-3.0-generate-preview",
  );

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const isIdentityDirty =
    agentName !== initialAgentName ||
    agentEmoji !== initialAgentEmoji ||
    agentPurpose !== initialAgentPurpose ||
    agentSoul !== initialAgentSoul;

  const isEnvDirty =
    apiKeyDirty ||
    openrouterApiKeyDirty ||
    apiProvider !== initialApiProvider ||
    model !== initialModel ||
    permissionMode !== initialPermissionMode ||
    daemonPort !== initialDaemonPort ||
    gcpProject !== initialGcpProject ||
    gcpRegion !== initialGcpRegion ||
    smartRouting !== initialSmartRouting ||
    modelSimple !== initialModelSimple ||
    modelModerate !== initialModelModerate ||
    modelComplex !== initialModelComplex ||
    anthropicBaseUrl !== initialAnthropicBaseUrl ||
    teamMode !== initialTeamMode ||
    maxTeamWorkers !== initialMaxTeamWorkers ||
    adaptiveMemory !== initialAdaptiveMemory ||
    extractionModel !== initialExtractionModel ||
    geminiApiKeyDirty ||
    imageGeneration !== initialImageGeneration ||
    imageGenerationModel !== initialImageGenerationModel ||
    videoGeneration !== initialVideoGeneration ||
    videoGenerationModel !== initialVideoGenerationModel;

  const isDirty = isIdentityDirty || isEnvDirty;
  useUnsavedChanges(isDirty);

  const loadData = useCallback(async () => {
    try {
      const [envRes, configRes] = await Promise.all([fetch("/api/env"), fetch("/api/config")]);
      const envData = await envRes.json();
      const configData = await configRes.json();

      const ap =
        envData.NOMOS_API_PROVIDER ??
        (envData.CLAUDE_CODE_USE_VERTEX === "1" ? "vertex" : "anthropic");
      setApiProvider(ap);
      setInitialApiProvider(ap);

      setHasApiKey(!!envData.ANTHROPIC_API_KEY);
      setApiKey("");
      setApiKeyDirty(false);

      setHasOpenrouterApiKey(!!envData.OPENROUTER_API_KEY);
      setOpenrouterApiKey("");
      setOpenrouterApiKeyDirty(false);

      const m = envData.NOMOS_MODEL ?? "claude-sonnet-4-6";
      setModel(m);
      setInitialModel(m);

      const pm = envData.NOMOS_PERMISSION_MODE ?? "default";
      setPermissionMode(pm);
      setInitialPermissionMode(pm);

      const dp = envData.DAEMON_PORT ?? "8765";
      setDaemonPort(dp);
      setInitialDaemonPort(dp);

      const proj = envData.GOOGLE_CLOUD_PROJECT ?? "";
      setGcpProject(proj);
      setInitialGcpProject(proj);

      const region = envData.CLOUD_ML_REGION ?? "us-east5";
      setGcpRegion(region);
      setInitialGcpRegion(region);

      // Smart model routing
      const sr = envData.NOMOS_SMART_ROUTING === "true";
      setSmartRouting(sr);
      setInitialSmartRouting(sr);

      const ms = envData.NOMOS_MODEL_SIMPLE ?? "claude-haiku-4-5";
      setModelSimple(ms);
      setInitialModelSimple(ms);

      const mm = envData.NOMOS_MODEL_MODERATE ?? "claude-sonnet-4-6";
      setModelModerate(mm);
      setInitialModelModerate(mm);

      const mc = envData.NOMOS_MODEL_COMPLEX ?? "claude-sonnet-4-6";
      setModelComplex(mc);
      setInitialModelComplex(mc);

      // Custom API endpoint
      const baseUrl = envData.ANTHROPIC_BASE_URL ?? "";
      setAnthropicBaseUrl(baseUrl);
      setInitialAnthropicBaseUrl(baseUrl);

      // Multi-agent teams
      const tm = envData.NOMOS_TEAM_MODE === "true";
      setTeamMode(tm);
      setInitialTeamMode(tm);

      const mtw = envData.NOMOS_MAX_TEAM_WORKERS || "4";
      setMaxTeamWorkers(mtw);
      setInitialMaxTeamWorkers(mtw);

      // Adaptive memory
      const am = envData.NOMOS_ADAPTIVE_MEMORY !== "false";
      setAdaptiveMemory(am);
      setInitialAdaptiveMemory(am);

      const em = envData.NOMOS_EXTRACTION_MODEL ?? "claude-haiku-4-5";
      setExtractionModel(em);
      setInitialExtractionModel(em);

      // Image generation
      const ig = envData.NOMOS_IMAGE_GENERATION === "true";
      setImageGeneration(ig);
      setInitialImageGeneration(ig);

      setHasGeminiApiKey(!!envData.GEMINI_API_KEY);
      setGeminiApiKey("");
      setGeminiApiKeyDirty(false);

      const igm = envData.NOMOS_IMAGE_GENERATION_MODEL ?? "gemini-3-pro-image-preview";
      setImageGenerationModel(igm);
      setInitialImageGenerationModel(igm);

      // Video generation
      const vg = envData.NOMOS_VIDEO_GENERATION === "true";
      setVideoGeneration(vg);
      setInitialVideoGeneration(vg);

      const vgm = envData.NOMOS_VIDEO_GENERATION_MODEL ?? "veo-3.0-generate-preview";
      setVideoGenerationModel(vgm);
      setInitialVideoGenerationModel(vgm);

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

      const soul = (configData["agent.soul"] as string) ?? "";
      setAgentSoul(soul);
      setInitialAgentSoul(soul);
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
        if (agentSoul !== initialAgentSoul) configUpdates["agent.soul"] = agentSoul;

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
        if (apiProvider !== initialApiProvider) envUpdates.NOMOS_API_PROVIDER = apiProvider;
        if (apiKeyDirty) envUpdates.ANTHROPIC_API_KEY = apiKey;
        if (openrouterApiKeyDirty) envUpdates.OPENROUTER_API_KEY = openrouterApiKey;
        if (model !== initialModel) envUpdates.NOMOS_MODEL = model;
        if (permissionMode !== initialPermissionMode)
          envUpdates.NOMOS_PERMISSION_MODE = permissionMode;
        if (daemonPort !== initialDaemonPort) envUpdates.DAEMON_PORT = daemonPort;
        // Set Vertex flag based on provider selection
        if (apiProvider !== initialApiProvider) {
          envUpdates.CLAUDE_CODE_USE_VERTEX = apiProvider === "vertex" ? "1" : "";
        }
        if (gcpProject !== initialGcpProject) envUpdates.GOOGLE_CLOUD_PROJECT = gcpProject;
        if (gcpRegion !== initialGcpRegion) envUpdates.CLOUD_ML_REGION = gcpRegion;
        if (smartRouting !== initialSmartRouting)
          envUpdates.NOMOS_SMART_ROUTING = smartRouting ? "true" : "";
        if (modelSimple !== initialModelSimple) envUpdates.NOMOS_MODEL_SIMPLE = modelSimple;
        if (modelModerate !== initialModelModerate) envUpdates.NOMOS_MODEL_MODERATE = modelModerate;
        if (modelComplex !== initialModelComplex) envUpdates.NOMOS_MODEL_COMPLEX = modelComplex;
        // Set base URL based on provider
        if (apiProvider === "openrouter") {
          envUpdates.ANTHROPIC_BASE_URL = "https://openrouter.ai/api/v1";
        } else if (apiProvider === "anthropic" || apiProvider === "vertex") {
          envUpdates.ANTHROPIC_BASE_URL = "";
        } else if (anthropicBaseUrl !== initialAnthropicBaseUrl) {
          envUpdates.ANTHROPIC_BASE_URL = anthropicBaseUrl;
        }
        if (teamMode !== initialTeamMode) envUpdates.NOMOS_TEAM_MODE = teamMode ? "true" : "";
        if (maxTeamWorkers !== initialMaxTeamWorkers)
          envUpdates.NOMOS_MAX_TEAM_WORKERS = maxTeamWorkers;
        if (adaptiveMemory !== initialAdaptiveMemory)
          envUpdates.NOMOS_ADAPTIVE_MEMORY = adaptiveMemory ? "true" : "";
        if (extractionModel !== initialExtractionModel)
          envUpdates.NOMOS_EXTRACTION_MODEL = extractionModel;
        if (imageGeneration !== initialImageGeneration)
          envUpdates.NOMOS_IMAGE_GENERATION = imageGeneration ? "true" : "";
        if (geminiApiKeyDirty) envUpdates.GEMINI_API_KEY = geminiApiKey;
        if (imageGenerationModel !== initialImageGenerationModel)
          envUpdates.NOMOS_IMAGE_GENERATION_MODEL = imageGenerationModel;
        if (videoGeneration !== initialVideoGeneration)
          envUpdates.NOMOS_VIDEO_GENERATION = videoGeneration ? "true" : "";
        if (videoGenerationModel !== initialVideoGenerationModel)
          envUpdates.NOMOS_VIDEO_GENERATION_MODEL = videoGenerationModel;

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
      <p className="text-sm text-overlay0 mb-8">Personality, model selection, and configuration</p>

      {/* Identity & Personality */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Identity & Personality
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
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Avatar</label>
              <EmojiPicker value={agentEmoji} onChange={setAgentEmoji} />
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
              Defines your assistant&apos;s core role and how it approaches problems
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-subtext1">Personality</label>
            <textarea
              value={agentSoul}
              onChange={(e) => setAgentSoul(e.target.value)}
              placeholder={`Direct and competent. Lead with answers, not disclaimers.\nProactive — anticipate what the user needs next.\nConcise by default, thorough when needed.\nHonest about uncertainty.`}
              rows={8}
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 resize-y font-mono"
            />
            <p className="text-xs text-overlay0">
              Free-form personality instructions injected into the system prompt. Overridden by{" "}
              <code className="text-xs bg-surface0 px-1 rounded">~/.nomos/SOUL.md</code> if that
              file exists.
            </p>
          </div>
        </div>
      </section>

      {/* API Provider */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          API Provider
        </h2>
        <div className="space-y-3">
          {[
            {
              value: "anthropic",
              label: "Anthropic",
              description: "Direct API access via Anthropic",
            },
            {
              value: "vertex",
              label: "Google Cloud / Vertex AI",
              description: "Route requests through Google Cloud Vertex AI",
            },
            {
              value: "openrouter",
              label: "OpenRouter",
              description: "Access Anthropic models via OpenRouter",
            },
            {
              value: "ollama",
              label: "Ollama",
              description: "Local models via Ollama + LiteLLM proxy",
            },
            {
              value: "custom",
              label: "Custom Endpoint",
              description: "Any Anthropic-compatible API proxy",
            },
          ].map((p) => (
            <label
              key={p.value}
              className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                apiProvider === p.value
                  ? "border-mauve/50 bg-mauve/5"
                  : "border-surface0 bg-base hover:border-surface1"
              }`}
            >
              <input
                type="radio"
                name="apiProvider"
                value={p.value}
                checked={apiProvider === p.value}
                onChange={(e) => setApiProvider(e.target.value)}
                className="accent-mauve"
              />
              <div>
                <span className="text-sm font-medium text-text">{p.label}</span>
                <p className="text-xs text-overlay0">{p.description}</p>
              </div>
            </label>
          ))}
        </div>

        {/* Anthropic-specific config */}
        {apiProvider === "anthropic" && (
          <div className="mt-4 pt-4 border-t border-surface0">
            <TokenInput
              label="API Key"
              value={apiKey}
              onChange={(v) => {
                setApiKey(v);
                setApiKeyDirty(true);
              }}
              placeholder={hasApiKey ? "Configured - enter new value to replace" : "sk-ant-..."}
              helperText="Your Anthropic API key"
            />
          </div>
        )}

        {/* Vertex AI config */}
        {apiProvider === "vertex" && (
          <div className="mt-4 pt-4 border-t border-surface0 space-y-4">
            <div className="flex items-center justify-end">
              <a
                href="https://console.cloud.google.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
              >
                GCP Console <ExternalLink size={10} />
              </a>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">GCP Project ID</label>
              <input
                type="text"
                value={gcpProject}
                onChange={(e) => setGcpProject(e.target.value)}
                placeholder="my-project-12345"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Region</label>
              <select
                value={gcpRegion}
                onChange={(e) => setGcpRegion(e.target.value)}
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
              >
                {VERTEX_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <p className="text-xs text-overlay0">
                Requires{" "}
                <code className="text-xs bg-surface0 px-1 rounded">
                  gcloud auth application-default login
                </code>
              </p>
            </div>
          </div>
        )}

        {/* OpenRouter config */}
        {apiProvider === "openrouter" && (
          <div className="mt-4 pt-4 border-t border-surface0 space-y-4">
            <div className="flex items-center justify-end">
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
              >
                Get API Key <ExternalLink size={10} />
              </a>
            </div>
            <TokenInput
              label="OpenRouter API Key"
              value={openrouterApiKey}
              onChange={(v) => {
                setOpenrouterApiKey(v);
                setOpenrouterApiKeyDirty(true);
              }}
              placeholder={
                hasOpenrouterApiKey ? "Configured - enter new value to replace" : "sk-or-..."
              }
              helperText="Your OpenRouter API key. Anthropic models are accessed via OpenRouter's Anthropic-compatible endpoint."
            />
          </div>
        )}

        {/* Ollama config */}
        {apiProvider === "ollama" && (
          <div className="mt-4 pt-4 border-t border-surface0 space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">LiteLLM Proxy URL</label>
              <input
                type="text"
                value={anthropicBaseUrl}
                onChange={(e) => setAnthropicBaseUrl(e.target.value)}
                placeholder="http://localhost:4000"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
              />
              <p className="text-xs text-overlay0">
                Ollama requires a LiteLLM proxy for Anthropic API compatibility. Start with:{" "}
                <code className="text-xs bg-surface0 px-1 rounded">
                  litellm --model ollama/llama3 --port 4000
                </code>
              </p>
            </div>
          </div>
        )}

        {/* Custom endpoint config */}
        {apiProvider === "custom" && (
          <div className="mt-4 pt-4 border-t border-surface0 space-y-4">
            <TokenInput
              label="API Key"
              value={apiKey}
              onChange={(v) => {
                setApiKey(v);
                setApiKeyDirty(true);
              }}
              placeholder={hasApiKey ? "Configured - enter new value to replace" : "API key..."}
              helperText="API key for your custom endpoint (sent as the Anthropic API key)"
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-subtext1">Base URL</label>
              <input
                type="text"
                value={anthropicBaseUrl}
                onChange={(e) => setAnthropicBaseUrl(e.target.value)}
                placeholder="https://your-proxy.example.com"
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
              />
              <p className="text-xs text-overlay0">
                Any Anthropic-compatible API endpoint (AWS Bedrock, Azure, corporate gateway, etc.)
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Model Configuration */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Model Configuration
        </h2>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-subtext1">Default Model</label>
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
            <p className="text-xs text-overlay0">
              Used for all queries unless smart routing is enabled
            </p>
          </div>

          {/* Smart Model Routing */}
          <div className="pt-2 border-t border-surface0">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={smartRouting}
                onChange={(e) => setSmartRouting(e.target.checked)}
                className="accent-mauve w-4 h-4 rounded"
              />
              <div>
                <span className="text-sm font-medium text-text">Smart Model Routing</span>
                <p className="text-xs text-overlay0">
                  Automatically route queries to different models based on complexity for cost
                  optimization
                </p>
              </div>
            </label>
          </div>

          {smartRouting && (
            <div className="space-y-3 pl-7 border-l-2 border-surface1 ml-2">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-subtext1">Simple Queries</label>
                <select
                  value={modelSimple}
                  onChange={(e) => setModelSimple(e.target.value)}
                  className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-overlay0">Greetings, short questions, simple lookups</p>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-subtext1">Moderate Queries</label>
                <select
                  value={modelModerate}
                  onChange={(e) => setModelModerate(e.target.value)}
                  className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-overlay0">General tasks, summaries, standard work</p>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-subtext1">Complex Queries</label>
                <select
                  value={modelComplex}
                  onChange={(e) => setModelComplex(e.target.value)}
                  className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-overlay0">Coding, reasoning, multi-step analysis</p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Multi-Agent Teams */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Multi-Agent Teams
        </h2>
        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={teamMode}
              onChange={(e) => setTeamMode(e.target.checked)}
              className="accent-mauve w-4 h-4 rounded"
            />
            <div>
              <span className="text-sm font-medium text-text">Enable Team Mode</span>
              <p className="text-xs text-overlay0">
                Decompose complex tasks across parallel worker agents. Trigger with{" "}
                <code className="text-xs bg-surface0 px-1 rounded">/team</code> prefix.
              </p>
            </div>
          </label>

          {teamMode && (
            <div className="space-y-1.5 pl-7 border-l-2 border-surface1 ml-2">
              <label className="block text-sm font-medium text-subtext1">
                Max Parallel Workers
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={maxTeamWorkers}
                onChange={(e) => setMaxTeamWorkers(e.target.value)}
                className="w-full max-w-xs rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
              />
              <p className="text-xs text-overlay0">
                Number of worker agents that can run simultaneously (default: 4)
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Adaptive Memory */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Adaptive Memory
        </h2>
        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={adaptiveMemory}
              onChange={(e) => setAdaptiveMemory(e.target.checked)}
              className="accent-mauve w-4 h-4 rounded"
            />
            <div>
              <span className="text-sm font-medium text-text">Enable Adaptive Memory</span>
              <p className="text-xs text-overlay0">
                Extract facts, preferences, and corrections from conversations to build a user model
                over time.
              </p>
            </div>
          </label>

          {adaptiveMemory && (
            <div className="space-y-1.5 pl-7 border-l-2 border-surface1 ml-2">
              <label className="block text-sm font-medium text-subtext1">Extraction Model</label>
              <select
                value={extractionModel}
                onChange={(e) => setExtractionModel(e.target.value)}
                className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-overlay0">
                Model used for knowledge extraction. Haiku recommended for cost efficiency.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Image Generation */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Image Generation
        </h2>
        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={imageGeneration}
              onChange={(e) => setImageGeneration(e.target.checked)}
              className="accent-mauve w-4 h-4 rounded"
            />
            <div>
              <span className="text-sm font-medium text-text">Enable Image Generation</span>
              <p className="text-xs text-overlay0">
                Generate images from text prompts using Google&apos;s Gemini model via the{" "}
                <code className="text-xs bg-surface0 px-1 rounded">generate_image</code> tool.
                {apiProvider === "vertex" ? (
                  <span className="text-green ml-1">Using Vertex AI.</span>
                ) : hasGeminiApiKey ? (
                  <span className="text-green ml-1">Gemini API key configured.</span>
                ) : (
                  <span className="text-peach ml-1">Requires Vertex AI or a Gemini API key.</span>
                )}
              </p>
            </div>
          </label>

          {imageGeneration && (
            <div className="space-y-4 pl-7 border-l-2 border-surface1 ml-2">
              {apiProvider !== "vertex" && (
                <TokenInput
                  label="Gemini API Key"
                  value={geminiApiKey}
                  onChange={(v) => {
                    setGeminiApiKey(v);
                    setGeminiApiKeyDirty(true);
                  }}
                  placeholder={
                    hasGeminiApiKey
                      ? "Configured - enter new value to replace"
                      : "Your Gemini API key"
                  }
                  helperText={
                    <>
                      Get a free API key from{" "}
                      <a
                        href="https://aistudio.google.com/apikey"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue hover:text-blue/80 underline"
                      >
                        Google AI Studio
                      </a>
                    </>
                  }
                />
              )}
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-subtext1">Model</label>
                <input
                  type="text"
                  value={imageGenerationModel}
                  onChange={(e) => setImageGenerationModel(e.target.value)}
                  placeholder="gemini-3-pro-image-preview"
                  className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
                />
                <p className="text-xs text-overlay0">
                  Gemini model with image generation capabilities
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Video Generation */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Video Generation
        </h2>
        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={videoGeneration}
              onChange={(e) => setVideoGeneration(e.target.checked)}
              className="accent-mauve w-4 h-4 rounded"
            />
            <div>
              <span className="text-sm font-medium text-text">Enable Video Generation</span>
              <p className="text-xs text-overlay0">
                Generate videos from text prompts using Google&apos;s Veo model via the{" "}
                <code className="text-xs bg-surface0 px-1 rounded">generate_video</code> tool.
                {apiProvider === "vertex" ? (
                  <span className="text-green ml-1">Using Vertex AI.</span>
                ) : hasGeminiApiKey || imageGeneration ? (
                  <span className="text-green ml-1">Gemini API key configured.</span>
                ) : (
                  <span className="text-peach ml-1">Requires Vertex AI or a Gemini API key.</span>
                )}
              </p>
            </div>
          </label>

          {videoGeneration && (
            <div className="space-y-4 pl-7 border-l-2 border-surface1 ml-2">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-subtext1">Model</label>
                <input
                  type="text"
                  value={videoGenerationModel}
                  onChange={(e) => setVideoGenerationModel(e.target.value)}
                  placeholder="veo-3.0-generate-preview"
                  className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
                />
                <p className="text-xs text-overlay0">
                  Veo model for video generation. Videos may take 1-3 minutes to generate.
                </p>
              </div>
            </div>
          )}
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
                      <span className="text-sm font-medium text-text">{pm.label}</span>
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
                <label className="block text-sm font-medium text-subtext1">WebSocket Port</label>
                <input
                  type="number"
                  value={daemonPort}
                  onChange={(e) => setDaemonPort(e.target.value)}
                  placeholder="8765"
                  className="w-full max-w-xs rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
                />
                <p className="text-xs text-overlay0">
                  Port for daemon WebSocket server (default: 8765)
                </p>
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

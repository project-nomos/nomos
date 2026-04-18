"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Puzzle, Sparkles, Package, ChevronDown, ChevronRight } from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface SkillInfo {
  name: string;
  description: string;
  source: string;
  emoji?: string;
  filePath: string;
}

interface PluginInfo {
  name: string;
  description: string;
  marketplace: string;
  source: string;
  version: string;
  installedAt: string;
}

interface ExtensionsData {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  error?: string;
}

function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

const SOURCE_COLORS: Record<string, string> = {
  bundled: "bg-mauve/15 text-mauve",
  personal: "bg-teal/15 text-teal",
  project: "bg-peach/15 text-peach",
  plugins: "bg-blue/15 text-blue",
  external_plugins: "bg-green/15 text-green",
};

function SourceBadge({ source }: { source: string }) {
  const label = source === "external_plugins" ? "community" : source;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${SOURCE_COLORS[source] ?? "bg-surface0 text-subtext0"}`}
    >
      {label}
    </span>
  );
}

function SkillRow({
  skill,
  expanded,
  onToggle,
}: {
  skill: SkillInfo;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-surface0/50 bg-base">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface0/30 transition-colors"
      >
        <span className="text-overlay0 shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-base shrink-0 w-6 text-center">{skill.emoji ?? "📄"}</span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-text">{skill.name}</span>
          {skill.description && (
            <span className="text-sm text-overlay0 ml-2">{skill.description}</span>
          )}
        </div>
        <SourceBadge source={skill.source} />
      </button>
      {expanded && (
        <div className="border-t border-surface0/50 px-4 py-3">
          <div className="flex flex-col gap-1.5 text-xs text-overlay0">
            <div>
              <span className="text-subtext0 font-medium">Path: </span>
              <span className="font-mono">{skill.filePath}</span>
            </div>
            <div>
              <span className="text-subtext0 font-medium">Source: </span>
              {skill.source}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  expanded,
  onToggle,
}: {
  plugin: PluginInfo;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-surface0/50 bg-base">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface0/30 transition-colors"
      >
        <span className="text-overlay0 shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <Package size={16} className="text-mauve shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-text">{plugin.name}</span>
          {plugin.description && (
            <span className="text-sm text-overlay0 ml-2 line-clamp-1">{plugin.description}</span>
          )}
        </div>
        <SourceBadge source={plugin.source} />
      </button>
      {expanded && (
        <div className="border-t border-surface0/50 px-4 py-3">
          <div className="flex flex-col gap-1.5 text-xs text-overlay0">
            {plugin.description && (
              <div>
                <span className="text-subtext0 font-medium">Description: </span>
                {plugin.description}
              </div>
            )}
            <div>
              <span className="text-subtext0 font-medium">Marketplace: </span>
              {plugin.marketplace}
            </div>
            <div>
              <span className="text-subtext0 font-medium">Type: </span>
              {plugin.source === "external_plugins" ? "Community" : "First-party"}
            </div>
            <div>
              <span className="text-subtext0 font-medium">Version: </span>
              {plugin.version}
            </div>
            {plugin.installedAt && (
              <div>
                <span className="text-subtext0 font-medium">Installed: </span>
                {formatRelativeTime(plugin.installedAt)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ size: number; className?: string }>;
}) {
  return (
    <div className="rounded-lg border border-surface0/50 bg-base p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className="text-overlay0" />
        <p className="text-xs text-overlay0">{label}</p>
      </div>
      <p className="text-xl font-semibold text-text tabular-nums">{value}</p>
    </div>
  );
}

export default function ExtensionsPage() {
  const { addToast } = useToast();
  const [data, setData] = useState<ExtensionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [skillFilter, setSkillFilter] = useState<string>("all");

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/extensions");
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        setData(null);
      } else {
        setData(json);
        setError(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect";
      setError(message);
      setData(null);
      addToast("Failed to load extensions data", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-2xl font-bold text-text mb-1">Extensions</h1>
        <p className="text-sm text-overlay0 mb-8">Skills and plugins registered with Nomos</p>
        <section className="rounded-xl border border-surface0 bg-mantle p-5">
          <p className="text-sm text-red mb-4">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              loadData();
            }}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-sm text-subtext0 hover:bg-surface0 transition-colors"
          >
            <RefreshCw size={14} />
            Retry
          </button>
        </section>
      </div>
    );
  }

  if (!data) return null;

  const skillSources = [...new Set(data.skills.map((s) => s.source))].sort();
  const filteredSkills =
    skillFilter === "all" ? data.skills : data.skills.filter((s) => s.source === skillFilter);
  const firstPartyPlugins = data.plugins.filter((p) => p.source === "plugins");
  const communityPlugins = data.plugins.filter((p) => p.source === "external_plugins");

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-text">Extensions</h1>
        <button
          onClick={() => {
            setLoading(true);
            loadData();
          }}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-sm text-subtext0 hover:bg-surface0 transition-colors"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <p className="text-sm text-overlay0 mb-8">Skills and plugins registered with Nomos</p>

      {/* Stats */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Overview
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Skills" value={data.skills.length} icon={Sparkles} />
          <StatCard label="Plugins" value={data.plugins.length} icon={Puzzle} />
          <StatCard label="First-party" value={firstPartyPlugins.length} icon={Package} />
          <StatCard label="Community" value={communityPlugins.length} icon={Package} />
        </div>
      </section>

      {/* Skills */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider">
            Skills ({filteredSkills.length})
          </h2>
          {skillSources.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setSkillFilter("all")}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  skillFilter === "all"
                    ? "bg-surface0 text-text font-medium"
                    : "text-overlay0 hover:text-text"
                }`}
              >
                All
              </button>
              {skillSources.map((source) => (
                <button
                  key={source}
                  onClick={() => setSkillFilter(source)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    skillFilter === source
                      ? "bg-surface0 text-text font-medium"
                      : "text-overlay0 hover:text-text"
                  }`}
                >
                  {source}
                </button>
              ))}
            </div>
          )}
        </div>
        {filteredSkills.length === 0 ? (
          <p className="text-sm text-overlay0">No skills found</p>
        ) : (
          <div className="space-y-1.5">
            {filteredSkills.map((skill) => (
              <SkillRow
                key={`${skill.source}:${skill.name}`}
                skill={skill}
                expanded={expandedSkill === `${skill.source}:${skill.name}`}
                onToggle={() =>
                  setExpandedSkill(
                    expandedSkill === `${skill.source}:${skill.name}`
                      ? null
                      : `${skill.source}:${skill.name}`,
                  )
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Plugins */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Plugins ({data.plugins.length})
        </h2>
        {data.plugins.length === 0 ? (
          <div className="text-sm text-overlay0">
            <p>No plugins installed.</p>
            <p className="mt-1">
              Install plugins via{" "}
              <code className="text-xs bg-surface0 px-1.5 py-0.5 rounded font-mono">
                nomos plugin install &lt;name&gt;
              </code>
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.plugins.map((plugin) => (
              <PluginRow
                key={plugin.name}
                plugin={plugin}
                expanded={expandedPlugin === plugin.name}
                onToggle={() =>
                  setExpandedPlugin(expandedPlugin === plugin.name ? null : plugin.name)
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* CLI hint */}
      <section className="mb-8 rounded-xl border border-surface0/50 bg-mantle/50 p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-3">
          CLI Commands
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono text-overlay0">
          <div className="bg-surface0/30 rounded-lg px-3 py-2">nomos plugin list</div>
          <div className="bg-surface0/30 rounded-lg px-3 py-2">nomos plugin available</div>
          <div className="bg-surface0/30 rounded-lg px-3 py-2">
            nomos plugin install &lt;name&gt;
          </div>
          <div className="bg-surface0/30 rounded-lg px-3 py-2">
            nomos plugin remove &lt;name&gt;
          </div>
        </div>
      </section>
    </div>
  );
}

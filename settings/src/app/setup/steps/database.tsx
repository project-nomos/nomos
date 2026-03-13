"use client";

import { useState } from "react";
import { Database, CheckCircle, AlertCircle, Loader2, Terminal, Copy, Check } from "lucide-react";

interface DatabaseStepProps {
  onComplete: () => void;
}

const DOCKER_COMMAND =
  "docker run -d --name nomos-db \\\n  -e POSTGRES_USER=nomos -e POSTGRES_PASSWORD=nomos \\\n  -e POSTGRES_DB=nomos -p 5432:5432 \\\n  pgvector/pgvector:pg17";

const DEFAULT_URL = "postgresql://nomos:nomos@localhost:5432/nomos";

export function DatabaseStep({ onComplete }: DatabaseStepProps) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(DOCKER_COMMAND.replace(/\\\n\s*/g, " "));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const testConnection = async () => {
    setTesting(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/setup/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ databaseUrl: url }),
      });

      const data = await res.json();
      if (data.ok) {
        setSuccess(true);
        // Brief delay to show success state before advancing
        setTimeout(onComplete, 800);
      } else {
        setError(data.error || "Connection failed");
      }
    } catch {
      setError("Failed to reach the setup server");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-blue/10 border border-blue/20 flex items-center justify-center">
          <Database size={20} className="text-blue" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-text">Database</h2>
          <p className="text-sm text-overlay0">PostgreSQL with pgvector</p>
        </div>
      </div>

      {/* Docker Quick Start */}
      <div className="rounded-xl border border-surface0 bg-mantle p-4">
        <div className="flex items-center gap-2 mb-3">
          <Terminal size={14} className="text-mauve" />
          <span className="text-xs font-semibold text-subtext1 uppercase tracking-wider">
            Quick Start with Docker
          </span>
        </div>
        <div className="relative">
          <pre className="text-xs text-subtext0 bg-crust rounded-lg p-3 font-mono overflow-x-auto">
            {DOCKER_COMMAND}
          </pre>
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-surface0 hover:bg-surface1 text-overlay0 hover:text-text transition-colors"
          >
            {copied ? (
              <Check size={12} className="text-green" />
            ) : (
              <Copy size={12} />
            )}
          </button>
        </div>
        <p className="text-xs text-overlay0 mt-2">
          Run this command to start a PostgreSQL instance with pgvector enabled.
        </p>
      </div>

      {/* Connection URL */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-subtext1">
          Connection URL
        </label>
        <input
          type="text"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
            setSuccess(false);
          }}
          placeholder="postgresql://user:password@host:5432/dbname"
          className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
        />
      </div>

      {/* Status */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-red/10 border border-red/20 p-3">
          <AlertCircle size={16} className="text-red mt-0.5 shrink-0" />
          <p className="text-sm text-red">{error}</p>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 rounded-lg bg-green/10 border border-green/20 p-3">
          <CheckCircle size={16} className="text-green" />
          <p className="text-sm text-green">
            Connected and migrations applied
          </p>
        </div>
      )}

      {/* Action */}
      <button
        onClick={testConnection}
        disabled={testing || !url || success}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {testing ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Testing connection...
          </>
        ) : success ? (
          <>
            <CheckCircle size={16} />
            Connected
          </>
        ) : (
          "Connect & Initialize"
        )}
      </button>
    </div>
  );
}

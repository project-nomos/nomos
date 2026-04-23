"use client";

import { useEffect, useState, useCallback } from "react";
import { BookOpen, RefreshCw, Clock } from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface WikiArticle {
  path: string;
  title: string;
  category: string;
  content: string;
  compiled_at: string;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function WikiPage() {
  const [articles, setArticles] = useState<WikiArticle[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<WikiArticle | null>(null);
  const [loading, setLoading] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const { addToast } = useToast();

  const fetchArticles = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/wiki");
      const data = await res.json();
      setArticles(data.articles ?? []);
    } catch {
      // table may not exist
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchArticles();
  }, [fetchArticles]);

  const triggerCompile = async () => {
    setCompiling(true);
    try {
      const res = await fetch("/api/admin/wiki", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        addToast(`Wiki compiled: ${data.created} created, ${data.updated} updated`, "success");
        await fetchArticles();
      } else {
        addToast(data.error ?? "Compilation failed", "error");
      }
    } catch {
      addToast("Failed to trigger compilation", "error");
    } finally {
      setCompiling(false);
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
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-text">Knowledge Wiki</h1>
        <button
          onClick={triggerCompile}
          disabled={compiling}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40"
        >
          {compiling ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Compile Now
        </button>
      </div>
      <p className="text-sm text-overlay0 mb-8">
        Compiled articles about contacts, projects, and topics. Auto-compiles every hour.
      </p>

      {articles.length === 0 ? (
        <div className="text-center py-16 text-overlay0">
          <BookOpen size={32} className="mx-auto mb-3 opacity-50" />
          <p>No wiki articles yet.</p>
          <p className="text-xs mt-1">
            Click &quot;Compile Now&quot; to generate from your knowledge base.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Article list */}
          <div className="space-y-2">
            {articles
              .filter((a) => a.path !== "_index.md")
              .map((article) => (
                <button
                  key={article.path}
                  onClick={() => setSelectedArticle(article)}
                  className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                    selectedArticle?.path === article.path
                      ? "border-mauve bg-mauve/10"
                      : "border-surface0 bg-mantle hover:border-surface1"
                  }`}
                >
                  <div className="text-sm font-medium text-text">{article.title}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-overlay0">{article.category}</span>
                    <span className="text-xs text-overlay0 flex items-center gap-1">
                      <Clock size={10} />
                      {formatRelativeTime(article.compiled_at)}
                    </span>
                  </div>
                </button>
              ))}
          </div>

          {/* Article content */}
          <div className="md:col-span-2">
            {selectedArticle ? (
              <div className="rounded-xl border border-surface0 bg-mantle p-5">
                <h2 className="text-lg font-bold text-text mb-1">{selectedArticle.title}</h2>
                <p className="text-xs text-overlay0 mb-4">
                  {selectedArticle.category} -- compiled{" "}
                  {formatRelativeTime(selectedArticle.compiled_at)}
                </p>
                <div className="prose prose-sm prose-invert max-w-none">
                  <pre className="whitespace-pre-wrap text-sm text-subtext0 font-sans leading-relaxed">
                    {selectedArticle.content}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-surface0 bg-mantle p-5 text-center text-overlay0 py-16">
                Select an article to view
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

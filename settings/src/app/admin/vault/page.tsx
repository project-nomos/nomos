"use client";

import { useEffect, useState, useCallback } from "react";
import { NotebookPen, RefreshCw, Plus, Trash2, Save, FileText } from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface NoteSummary {
  path: string;
  title: string;
  updatedAt: string;
  wordCount: number;
}

interface NoteDetail {
  path: string;
  title: string;
  content: string;
  updatedAt: string;
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

export default function VaultPage() {
  const { addToast } = useToast();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isNew, setIsNew] = useState(false);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/vault");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setNotes(data.notes ?? []);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to load vault", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  async function openNote(path: string) {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    try {
      const res = await fetch(`/api/admin/vault?path=${encodeURIComponent(path)}`);
      const data: NoteDetail = await res.json();
      setSelectedPath(path);
      setDraftPath(data.path);
      setDraftContent(data.content);
      setIsNew(false);
      setDirty(false);
    } catch {
      addToast("Failed to open note", "error");
    }
  }

  function newNote() {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    setSelectedPath(null);
    setDraftPath("");
    setDraftContent("");
    setIsNew(true);
    setDirty(true);
  }

  async function save() {
    const path = draftPath.trim();
    if (!path) {
      addToast("Give the note a path, e.g. people/dana.md", "error");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: draftContent }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      addToast("Saved", "success");
      setDirty(false);
      setIsNew(false);
      setSelectedPath(path);
      await loadNotes();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to save", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(path: string) {
    if (!confirm(`Forget "${path}"? This deletes the note.`)) return;
    try {
      const res = await fetch(`/api/admin/vault?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      addToast("Forgotten", "success");
      if (selectedPath === path) {
        setSelectedPath(null);
        setDraftPath("");
        setDraftContent("");
        setIsNew(false);
        setDirty(false);
      }
      await loadNotes();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to delete", "error");
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <NotebookPen className="text-mauve" size={22} />
          <div>
            <h1 className="text-text font-bold text-xl tracking-tight">Vault</h1>
            <p className="text-subtext0 text-sm">
              Your clone&apos;s long-term memory. Browse and correct what it knows about you.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={newNote}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-mauve text-crust font-medium hover:opacity-90"
          >
            <Plus size={15} /> New note
          </button>
          <button
            onClick={loadNotes}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-subtext0 hover:bg-surface0 hover:text-text"
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </header>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Note list */}
        <div className="w-72 shrink-0 border border-surface0 rounded-lg overflow-y-auto bg-mantle">
          {loading ? (
            <div className="p-4 text-subtext0 text-sm">Loading…</div>
          ) : notes.length === 0 ? (
            <div className="p-4 text-subtext0 text-sm">
              No notes yet. Your clone writes here as it learns, or start one with{" "}
              <span className="text-mauve">New note</span>.
            </div>
          ) : (
            <ul>
              {notes.map((n) => (
                <li key={n.path}>
                  <button
                    onClick={() => openNote(n.path)}
                    className={`w-full text-left px-3 py-2 border-b border-surface0/50 hover:bg-surface0 transition-colors ${
                      selectedPath === n.path ? "bg-surface0" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <FileText size={13} className="text-overlay0 shrink-0" />
                      <span className="text-text text-sm truncate">{n.title}</span>
                    </div>
                    <div className="text-overlay0 text-xs mt-0.5 truncate pl-5">{n.path}</div>
                    <div className="text-overlay0 text-xs pl-5">
                      {n.wordCount} words · {formatRelativeTime(n.updatedAt)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Editor */}
        <div className="flex-1 min-w-0 flex flex-col border border-surface0 rounded-lg bg-mantle">
          {!isNew && !selectedPath ? (
            <div className="flex-1 flex items-center justify-center text-subtext0 text-sm">
              Select a note to read or edit, or create a new one.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 p-3 border-b border-surface0">
                <input
                  value={draftPath}
                  onChange={(e) => {
                    setDraftPath(e.target.value);
                    setDirty(true);
                  }}
                  readOnly={!isNew}
                  placeholder="path/to/note.md"
                  className={`flex-1 bg-base border border-surface0 rounded-md px-3 py-1.5 text-sm text-text font-mono focus:outline-none focus:border-mauve ${
                    !isNew ? "opacity-70" : ""
                  }`}
                />
                <button
                  onClick={save}
                  disabled={saving || !dirty}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm bg-green text-crust font-medium hover:opacity-90 disabled:opacity-40"
                >
                  <Save size={15} /> {saving ? "Saving…" : "Save"}
                </button>
                {selectedPath && (
                  <button
                    onClick={() => remove(selectedPath)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-red hover:bg-surface0"
                  >
                    <Trash2 size={15} /> Forget
                  </button>
                )}
              </div>
              <textarea
                value={draftContent}
                onChange={(e) => {
                  setDraftContent(e.target.value);
                  setDirty(true);
                }}
                placeholder="Markdown. Use [[wikilinks]] to connect notes."
                className="flex-1 resize-none bg-mantle p-4 text-sm text-text font-mono leading-relaxed focus:outline-none"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

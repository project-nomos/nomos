"use client";

import { useState, useRef, useEffect } from "react";
import { Upload, X } from "lucide-react";

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "Faces",
    emojis: [
      "😀",
      "😎",
      "🤖",
      "👾",
      "🧠",
      "👻",
      "🤓",
      "😈",
      "🥷",
      "🧑‍💻",
      "🦊",
      "🐱",
      "🐶",
      "🦄",
      "🐉",
      "🦅",
    ],
  },
  {
    label: "Objects",
    emojis: [
      "🔮",
      "⚡",
      "🚀",
      "💎",
      "🔥",
      "✨",
      "🌟",
      "💫",
      "🛡️",
      "⚙️",
      "🧪",
      "🔬",
      "💡",
      "🎯",
      "🏆",
      "🎮",
    ],
  },
  {
    label: "Symbols",
    emojis: [
      "♟️",
      "🌀",
      "💠",
      "🔷",
      "🟣",
      "⬛",
      "🔶",
      "❤️",
      "☯️",
      "⚛️",
      "🪐",
      "🌊",
      "🍃",
      "🌙",
      "☀️",
      "🌈",
    ],
  },
];

interface EmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
}

export function EmojiPicker({ value, onChange }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check if avatar exists on mount
  useEffect(() => {
    fetch("/api/avatar")
      .then((res) => {
        if (res.ok && res.headers.get("content-type")?.startsWith("image/")) {
          setAvatarUrl(`/api/avatar?t=${Date.now()}`);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("avatar", file);

      const res = await fetch("/api/avatar", { method: "POST", body: formData });
      if (res.ok) {
        setAvatarUrl(`/api/avatar?t=${Date.now()}`);
        onChange(""); // Clear emoji when avatar is set
        setOpen(false);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveAvatar = async () => {
    await fetch("/api/avatar", { method: "DELETE" });
    setAvatarUrl(null);
  };

  const displayAvatar = avatarUrl && !value;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-10 h-10 rounded-xl border border-surface1 bg-surface0 flex items-center justify-center hover:border-mauve focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 transition-colors overflow-hidden"
        title="Pick an emoji or upload avatar"
      >
        {displayAvatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
        ) : value ? (
          <span className="text-lg">{value}</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/nomos-logo.svg" alt="Nomos" className="w-6 h-6 opacity-50" />
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-72 rounded-xl border border-surface0 bg-mantle shadow-lg p-3">
          {/* Avatar upload */}
          <div className="mb-3 pb-3 border-b border-surface0">
            <p className="text-[10px] font-semibold text-overlay0 uppercase tracking-wider mb-1.5 px-0.5">
              Avatar
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-dashed border-surface1 bg-base px-3 py-2 text-xs text-subtext0 hover:border-mauve hover:text-text transition-colors disabled:opacity-50"
              >
                <Upload size={12} />
                {uploading ? "Uploading..." : "Upload image"}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={handleRemoveAvatar}
                  className="p-2 rounded-lg border border-surface1 text-overlay0 hover:text-red hover:border-red/30 transition-colors"
                  title="Remove avatar"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              onChange={handleUpload}
              className="hidden"
            />
          </div>

          {/* Emoji grid */}
          {EMOJI_GROUPS.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <p className="text-[10px] font-semibold text-overlay0 uppercase tracking-wider mb-1.5 px-0.5">
                {group.label}
              </p>
              <div className="grid grid-cols-8 gap-0.5">
                {group.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onChange(emoji);
                      setOpen(false);
                    }}
                    className={`w-8 h-8 flex items-center justify-center rounded-md text-lg hover:bg-surface1 transition-colors ${
                      value === emoji ? "bg-surface1 ring-1 ring-mauve/50" : ""
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="w-full mt-2 pt-2 border-t border-surface0 text-xs text-overlay0 hover:text-red text-center transition-colors"
            >
              Remove emoji
            </button>
          )}
        </div>
      )}
    </div>
  );
}

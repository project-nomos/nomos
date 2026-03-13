"use client";

import { AlertCircle } from "lucide-react";

export function DirtyIndicator({ isDirty }: { isDirty: boolean }) {
  if (!isDirty) return null;

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-yellow">
      <AlertCircle size={14} />
      Unsaved changes
    </span>
  );
}

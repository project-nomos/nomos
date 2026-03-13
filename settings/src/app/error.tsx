"use client";

import { AlertTriangle } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center max-w-md">
        <AlertTriangle size={40} className="text-yellow mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-text mb-2">
          Something went wrong
        </h2>
        <p className="text-sm text-subtext0 mb-6">
          {error.message || "An unexpected error occurred"}
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}

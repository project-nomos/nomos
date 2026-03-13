"use client";

import { CheckCircle, XCircle, Info, X } from "lucide-react";
import { useToast, type ToastType } from "@/contexts/toast-context";

const variants: Record<ToastType, { bg: string; icon: typeof CheckCircle }> = {
  success: { bg: "bg-green/10 border-green/30 text-green", icon: CheckCircle },
  error: { bg: "bg-red/10 border-red/30 text-red", icon: XCircle },
  info: { bg: "bg-blue/10 border-blue/30 text-blue", icon: Info },
};

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => {
        const v = variants[toast.type];
        const Icon = v.icon;
        return (
          <div
            key={toast.id}
            className={`flex items-center gap-2 rounded-lg border p-3 shadow-lg ${v.bg} animate-in slide-in-from-right`}
          >
            <Icon size={16} className="shrink-0" />
            <span className="text-sm">{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              className="ml-2 shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

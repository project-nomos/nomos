"use client";

import { useState, useEffect } from "react";
import { DatabaseStep } from "./steps/database";
import { ApiKeyStep } from "./steps/api-key";
import { PersonalityStep } from "./steps/personality";
import { ChannelsStep } from "./steps/channels";
import { ReadyStep } from "./steps/ready";

const STEPS = [
  { label: "Database", number: 1 },
  { label: "API", number: 2 },
  { label: "Identity", number: 3 },
  { label: "Channels", number: 4 },
  { label: "Ready", number: 5 },
];

export default function SetupWizardPage() {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState({
    database: false,
    apiKey: false,
    agentName: false,
  });

  // Check current setup status on load
  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await fetch("/api/setup/status");
        const data = await res.json();

        setChecks(data.checks);

        if (data.complete) {
          setStep(5);
        } else if (data.step > 0) {
          setStep(data.step);
        }
      } catch {
        // Start from step 1 if we can't check
      } finally {
        setLoading(false);
      }
    }
    checkStatus();
  }, []);

  const advance = () => {
    const next = step + 1;
    // Update checks optimistically based on completed step
    if (step === 1) setChecks((c) => ({ ...c, database: true }));
    if (step === 2) setChecks((c) => ({ ...c, apiKey: true }));
    if (step === 3) setChecks((c) => ({ ...c, agentName: true }));
    setStep(Math.min(next, 5));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-text mb-1">Set up Nomos</h1>
        <p className="text-sm text-overlay0">{step < 5 ? `Step ${step} of 4` : "Setup complete"}</p>
      </div>

      {/* Progress Bar */}
      {step < 5 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            {STEPS.slice(0, 4).map((s) => (
              <div key={s.number} className="flex flex-col items-center gap-1">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                    s.number < step
                      ? "bg-green text-crust"
                      : s.number === step
                        ? "bg-mauve text-crust"
                        : "bg-surface0 text-overlay0"
                  }`}
                >
                  {s.number < step ? "\u2713" : s.number}
                </div>
                <span className={`text-xs ${s.number <= step ? "text-subtext0" : "text-overlay0"}`}>
                  {s.label}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-1 mt-2">
            {STEPS.slice(0, 4).map((s) => (
              <div
                key={s.number}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  s.number <= step ? "bg-mauve" : "bg-surface0"
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Step Content */}
      <div className="rounded-2xl border border-surface0 bg-base p-6">
        {step === 1 && <DatabaseStep onComplete={advance} />}
        {step === 2 && <ApiKeyStep onComplete={advance} />}
        {step === 3 && <PersonalityStep onComplete={advance} />}
        {step === 4 && <ChannelsStep onComplete={advance} />}
        {step === 5 && <ReadyStep checks={checks} />}
      </div>

      {/* Back button (for steps 2-4) */}
      {step > 1 && step < 5 && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            className="text-xs text-overlay0 hover:text-text transition-colors"
          >
            Back to previous step
          </button>
        </div>
      )}
    </div>
  );
}

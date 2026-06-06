import { NextResponse } from "next/server";

/**
 * Returns the current NOMOS_MODE and feature flags so the React UI can
 * conditionally render power-user knobs (or hide them in hosted mode).
 *
 * Mirrors the gates in `src/config/mode.ts` from the daemon side. Keep
 * the two in sync — they describe the same surface, one for backend
 * enforcement and one for UI affordances.
 */
export async function GET() {
  const mode = process.env.NOMOS_MODE?.trim().toLowerCase() === "hosted" ? "hosted" : "power_user";
  const isHosted = mode === "hosted";
  return NextResponse.json({
    mode,
    features: {
      byoMcp: !isHosted,
      byoPlugins: !isHosted,
      byoChannelTokens: !isHosted,
      byoSkills: !isHosted,
      customAnthropicBaseUrl: !isHosted,
      customModelTiers: !isHosted,
      bashTool: !isHosted,
      autonomousMode: !isHosted,
      iMessageChannel: !isHosted,
      setupWizard: !isHosted,
      adminPowerUserPages: !isHosted,
      autoDream: true,
      magicDocs: true,
      teamMode: true,
      memory: true,
      skills: true,
      smartRouting: true,
      draftManager: true,
    },
  });
}

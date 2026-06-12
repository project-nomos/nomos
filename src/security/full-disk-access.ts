/**
 * macOS Full Disk Access (TCC) helpers for the iMessage channel.
 *
 * Reading ~/Library/Messages/chat.db is gated by Full Disk Access. The nomos
 * daemon runs as a launchd LaunchAgent whose TCC context is SEPARATE from the
 * user's terminal -- so a terminal that can read chat.db says nothing about the
 * background service. macOS has no API to request FDA programmatically; it must
 * be granted by hand. The best a CLI can do is point the user at the exact
 * binary + the settings pane.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Deep link to System Settings > Privacy & Security > Full Disk Access.
const FDA_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export function messagesDbPath(): string {
  return path.join(os.homedir(), "Library", "Messages", "chat.db");
}

/**
 * Try to open the Messages database for reading. Returns false when macOS
 * denies access (Full Disk Access not granted) OR the file is absent. The
 * failed attempt also makes macOS register the running binary in the Full Disk
 * Access list, so the user has something to toggle on.
 */
export function canReadMessagesDb(): boolean {
  try {
    fs.closeSync(fs.openSync(messagesDbPath(), "r"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The binary the user must grant Full Disk Access to. The daemon's read of
 * chat.db is attributed by TCC to the node process running nomos (the launchd
 * job), not the leaf `imsg` wrapper -- so this is the entry that shows up in the
 * Full Disk Access list. `process.execPath` is that node binary, and the CLI
 * and daemon share it.
 */
export function fullDiskAccessBinary(): string {
  return process.execPath;
}

/** Open the Full Disk Access settings pane (best-effort, macOS only). */
export function openFullDiskAccessSettings(): void {
  if (process.platform !== "darwin") return;
  try {
    spawn("open", [FDA_SETTINGS_URL], { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort; the printed instructions still stand
  }
}

/**
 * Actionable one-liner for logs/CLI when chat.db can't be read. `binary`
 * defaults to the node binary that needs Full Disk Access.
 */
export function fullDiskAccessHint(binary: string = fullDiskAccessBinary()): string {
  return (
    "iMessage needs Full Disk Access for the background service to read " +
    "~/Library/Messages/chat.db. Grant it in System Settings > Privacy & Security > " +
    `Full Disk Access to: ${binary} -- then restart the service ` +
    "(launchctl kickstart -k gui/$(id -u)/com.projectnomos.daemon)."
  );
}

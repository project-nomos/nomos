/**
 * AppleScript wrapper for sending iMessages.
 */

import { execFile } from "node:child_process";

/** Escape a string for use inside AppleScript double-quoted literals. */
function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Send an iMessage via osascript.
 *
 * @param recipient - A phone/email handle (e.g. "+15551234567") or a chat GUID
 *                    (e.g. "iMessage;+;chat123456") for group chats.
 * @param text - The message body.
 */
export function sendIMessage(recipient: string, text: string): Promise<void> {
  const escaped = escapeAppleScript(text);
  const isGroupChat = recipient.startsWith("iMessage;+;") || recipient.startsWith("iMessage;-;");

  const script = isGroupChat
    ? `
tell application "Messages"
  set targetChat to chat id "${escapeAppleScript(recipient)}"
  send "${escaped}" to targetChat
end tell`
    : `
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${escapeAppleScript(recipient)}" of targetService
  send "${escaped}" to targetBuddy
end tell`;

  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 30_000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

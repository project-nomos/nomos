#!/bin/bash
# Install the Messages.app keep-alive LaunchAgent for BlueBubbles.
#
# This ensures Messages.app stays running so BlueBubbles can relay
# iMessages. The agent pokes Messages.app every 5 minutes.
#
# Usage: ./install-keepalive.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.nomos.poke-messages.plist"
SCRIPTS_DIR="$HOME/Scripts"
AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "Installing BlueBubbles Messages.app keep-alive..."

# Copy AppleScript
mkdir -p "$SCRIPTS_DIR"
cp "$SCRIPT_DIR/poke-messages.scpt" "$SCRIPTS_DIR/poke-messages.scpt"
echo "  Copied poke-messages.scpt to $SCRIPTS_DIR/"

# Copy LaunchAgent plist
mkdir -p "$AGENTS_DIR"
cp "$SCRIPT_DIR/$PLIST_NAME" "$AGENTS_DIR/$PLIST_NAME"
echo "  Copied $PLIST_NAME to $AGENTS_DIR/"

# Load the agent
launchctl unload "$AGENTS_DIR/$PLIST_NAME" 2>/dev/null || true
launchctl load "$AGENTS_DIR/$PLIST_NAME"
echo "  LaunchAgent loaded"

echo ""
echo "Done! Messages.app will be kept alive every 5 minutes."
echo "Logs: /tmp/nomos-poke-messages.log"
echo ""
echo "To uninstall:"
echo "  launchctl unload ~/Library/LaunchAgents/$PLIST_NAME"
echo "  rm ~/Library/LaunchAgents/$PLIST_NAME"
echo "  rm ~/Scripts/poke-messages.scpt"

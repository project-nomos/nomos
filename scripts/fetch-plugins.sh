#!/usr/bin/env bash
# Fetch Claude Code plugins from github.com/anthropics/claude-plugins-official
# These plugins are (c) Anthropic / their respective authors and distributed
# under the Apache 2.0 license. We fetch at build/install time instead of
# bundling to respect their terms.

set -euo pipefail

REPO="anthropics/claude-plugins-official"
BRANCH="main"
PLUGINS_DIR="${NOMOS_PLUGINS_DIR:-$HOME/.nomos/plugins}"
MANIFEST="$PLUGINS_DIR/installed.json"
TARBALL_URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"

# Plugins to fetch — first-party (plugins/) and community (external_plugins/)
FIRST_PARTY_PLUGINS=(
  agent-sdk-dev
  code-review
  code-simplifier
  commit-commands
  feature-dev
  frontend-design
  hookify
  learning-output-style
  math-olympiad
  mcp-server-dev
  plugin-dev
  pr-review-toolkit
  security-guidance
  skill-creator
)

COMMUNITY_PLUGINS=(
  discord
  github
  imessage
  linear
  playwright
  telegram
  terraform
)

# Marker file to track fetch status
MARKER="$PLUGINS_DIR/.plugins-fetched"

# Skip if already fetched (unless --force flag is passed)
if [ -f "$MARKER" ] && [ "${1:-}" != "--force" ]; then
  echo "Plugins already fetched. Use --force to re-fetch."
  exit 0
fi

echo "Fetching plugins from github.com/$REPO..."

mkdir -p "$PLUGINS_DIR"

# Download and extract the entire repo tarball
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl -sSL "$TARBALL_URL" | tar -xz -C "$TMPDIR"

EXTRACTED="$TMPDIR/claude-plugins-official-$BRANCH"

if [ ! -d "$EXTRACTED" ]; then
  echo "Error: Failed to download or extract plugins from $TARBALL_URL"
  exit 1
fi

# Read existing manifest or create empty one
if [ -f "$MANIFEST" ]; then
  EXISTING_JSON=$(cat "$MANIFEST")
else
  EXISTING_JSON='{"version":1,"plugins":[]}'
fi

INSTALLED_COUNT=0

install_plugin() {
  local name="$1"
  local subdir="$2"   # "plugins" or "external_plugins"
  local src="$EXTRACTED/$subdir/$name"
  local dst="$PLUGINS_DIR/$name"

  if [ ! -d "$src" ]; then
    echo "  Warning: $name not found in $subdir/, skipping"
    return
  fi

  # Verify it has a plugin manifest
  if [ ! -f "$src/.claude-plugin/plugin.json" ]; then
    echo "  Warning: $name has no .claude-plugin/plugin.json, skipping"
    return
  fi

  # If directory exists without .fetched marker, it's a user's own version — skip
  if [ -d "$dst" ] && [ ! -f "$dst/.fetched" ]; then
    echo "  Skipping $name (local version exists)"
    return
  fi

  rm -rf "$dst"
  cp -r "$src" "$dst"
  touch "$dst/.fetched"
  echo "  $name"
  INSTALLED_COUNT=$((INSTALLED_COUNT + 1))

  # Add to manifest JSON (will be written at the end)
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  EXISTING_JSON=$(echo "$EXISTING_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
name = '$name'
entry = {
    'name': name,
    'version': 'fetched',
    'marketplace': 'claude-plugins-official',
    'source': '$subdir',
    'installedAt': '$timestamp'
}
# Replace or append
plugins = data.get('plugins', [])
found = False
for i, p in enumerate(plugins):
    if p['name'] == name:
        plugins[i] = entry
        found = True
        break
if not found:
    plugins.append(entry)
data['plugins'] = plugins
json.dump(data, sys.stdout, indent=2)
")
}

echo "First-party plugins:"
for plugin in "${FIRST_PARTY_PLUGINS[@]}"; do
  install_plugin "$plugin" "plugins"
done

echo "Community plugins:"
for plugin in "${COMMUNITY_PLUGINS[@]}"; do
  install_plugin "$plugin" "external_plugins"
done

# Write updated manifest
echo "$EXISTING_JSON" > "$MANIFEST"

# Write marker
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER"
echo "Done! Fetched $INSTALLED_COUNT plugin(s)."

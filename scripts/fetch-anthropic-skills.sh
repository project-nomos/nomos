#!/usr/bin/env bash
# Fetch Anthropic's official skills from github.com/anthropics/skills
# These skills are (c) Anthropic and distributed under their license.
# We fetch at build/install time instead of bundling to respect their terms.

set -euo pipefail

REPO="anthropics/skills"
BRANCH="main"
SKILLS_DIR="$(cd "$(dirname "$0")/.." && pwd)/skills"
TARBALL_URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"

# Skills to fetch from Anthropic's repo
ANTHROPIC_SKILLS=(
  algorithmic-art
  brand-guidelines
  canvas-design
  docx
  frontend-design
  internal-comms
  mcp-builder
  pdf
  pptx
  skill-creator
  slack-gif-creator
  theme-factory
  web-artifacts-builder
  webapp-testing
  xlsx
)

# Marker file to track fetch status
MARKER="$SKILLS_DIR/.anthropic-skills-fetched"

# Skip if already fetched (unless --force flag is passed)
if [ -f "$MARKER" ] && [ "${1:-}" != "--force" ]; then
  echo "Anthropic skills already fetched. Use --force to re-fetch."
  exit 0
fi

echo "Fetching Anthropic skills from github.com/$REPO..."

# Download and extract the entire repo tarball (fast, no API rate limits)
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl -sSL "$TARBALL_URL" | tar -xz -C "$TMPDIR"

# The tarball extracts to skills-main/skills/
EXTRACTED="$TMPDIR/skills-$BRANCH/skills"

if [ ! -d "$EXTRACTED" ]; then
  echo "Error: Failed to download or extract skills from $TARBALL_URL"
  exit 1
fi

for skill in "${ANTHROPIC_SKILLS[@]}"; do
  src="$EXTRACTED/$skill"
  dst="$SKILLS_DIR/$skill"

  if [ ! -d "$src" ]; then
    echo "  Warning: $skill not found in Anthropic repo, skipping"
    continue
  fi

  # If directory exists without .fetched marker, it's a user's own version — skip
  if [ -d "$dst" ] && [ ! -f "$dst/.fetched" ]; then
    echo "  Skipping $skill (local version exists)"
    continue
  fi

  rm -rf "$dst"
  cp -r "$src" "$dst"
  touch "$dst/.fetched"
  echo "  $skill"
done

# Write marker
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER"
echo "Done! Fetched ${#ANTHROPIC_SKILLS[@]} Anthropic skills."

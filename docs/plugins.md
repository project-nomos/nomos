# Plugins

Nomos supports plugins from the Claude Code ecosystem. Plugins are packages that bundle skills, agents, hooks, and MCP servers — extending the agent's capabilities without modifying core code.

## Overview

Plugins are loaded via the Claude Agent SDK's native plugin system. Each plugin is a directory containing a `.claude-plugin/plugin.json` manifest, plus optional `skills/`, `agents/`, `hooks/`, and `.mcp.json` resources. Nomos discovers, installs, and loads plugins automatically — passing them to every SDK session (CLI, daemon, and team workers).

## Plugin Sources

Nomos browses the Claude Code marketplace — a local clone that Claude Code maintains at `~/.claude/plugins/marketplaces/`. This gives access to both first-party Anthropic plugins and community-contributed plugins without needing a separate registry.

| Source              | Location                                             | Contents                            |
| ------------------- | ---------------------------------------------------- | ----------------------------------- |
| **First-party**     | `~/.claude/plugins/marketplaces/*/plugins/`          | Official plugins from Anthropic     |
| **Community**       | `~/.claude/plugins/marketplaces/*/external_plugins/` | Community-contributed plugins       |
| **Nomos installed** | `~/.nomos/plugins/`                                  | Plugins installed for Nomos to load |

## CLI Usage

```bash
# List installed plugins
nomos plugin list

# Browse all available plugins from the marketplace
nomos plugin available

# Install a plugin
nomos plugin install <name>
nomos plugin install <name> --marketplace claude-plugins-official

# Remove an installed plugin
nomos plugin remove <name>

# Show details about a plugin
nomos plugin info <name>
```

### Examples

```bash
# See what's available
nomos plugin available

# Install the PR review toolkit
nomos plugin install pr-review-toolkit

# Install a community plugin
nomos plugin install linear

# Check what's installed
nomos plugin list

# Get info about a plugin
nomos plugin info code-review
```

## Pre-installed Plugins

Plugins are fetched at install/build time via `scripts/fetch-plugins.sh` — the same approach used for Anthropic skills. These plugins are Apache 2.0 licensed and fetched from `github.com/anthropics/claude-plugins-official` rather than bundled in the repo.

### First-party (from Anthropic)

| Plugin                    | What it provides                                                      |
| ------------------------- | --------------------------------------------------------------------- |
| **agent-sdk-dev**         | Claude Agent SDK development assistance                               |
| **code-review**           | Automated code review with multi-agent confidence scoring             |
| **code-simplifier**       | Simplifies and refines code for clarity and maintainability           |
| **commit-commands**       | Streamlined git workflow: commit, push, and create PRs                |
| **feature-dev**           | Feature development with codebase exploration and architecture design |
| **frontend-design**       | Frontend UI/UX design guidance                                        |
| **hookify**               | Create hooks to prevent unwanted behaviors from conversation patterns |
| **learning-output-style** | Interactive learning mode with decision-point code contributions      |
| **math-olympiad**         | Competition math solving with adversarial verification                |
| **mcp-server-dev**        | MCP server design and development guidance                            |
| **plugin-dev**            | Plugin development toolkit for agents, commands, hooks, and MCP       |
| **pr-review-toolkit**     | Specialized PR review agents: comments, tests, error handling, types  |
| **security-guidance**     | Security warnings for command injection, XSS, and unsafe patterns     |
| **skill-creator**         | Create, improve, and evaluate skills via conversation                 |

### Community

| Plugin         | What it provides                                                |
| -------------- | --------------------------------------------------------------- |
| **discord**    | Discord messaging bridge with access control                    |
| **github**     | GitHub MCP server: issues, PRs, code review, search             |
| **imessage**   | iMessage channel via chat.db with access control                |
| **linear**     | Linear issue tracking: create, manage, search across workspaces |
| **playwright** | Browser automation and E2E testing via Microsoft's MCP server   |
| **telegram**   | Telegram messaging bridge with access control                   |
| **terraform**  | Terraform IaC automation and interaction                        |

Plugins can be removed with `nomos plugin remove <name>` and additional ones installed with `nomos plugin install <name>`.

## How Plugins Are Loaded

1. **Fetch at install time** — `scripts/fetch-plugins.sh` downloads plugins from `github.com/anthropics/claude-plugins-official` and writes them to `~/.nomos/plugins/` with an `installed.json` manifest. This runs during `pnpm postinstall`, Docker build, and Homebrew install.
2. **Runtime fallback** — On daemon boot, `ensureDefaultPlugins()` checks if the fetch script has run. If not (e.g., manual source install), it installs defaults from the Claude marketplace clone at `~/.claude/plugins/marketplaces/`.
3. **Discovery** — `loadInstalledPlugins()` reads `~/.nomos/plugins/installed.json` and validates each plugin directory.
4. **SDK injection** — Valid plugins are passed as `{ type: 'local', path: '/absolute/path' }` to the SDK's `query()` call.
5. **SDK handles the rest** — The SDK loads skills, agents, hooks, and MCP servers from the plugin directory. Skills are namespaced as `plugin-name:skill-name` when invoked via slash commands.

Plugins are loaded once and cached for the lifetime of the process. New installs take effect on the next daemon restart or CLI session.

## Plugin Structure

A minimal plugin:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Required: { "name": "my-plugin", "description": "..." }
└── skills/
    └── my-skill/
        └── SKILL.md          # Skill content with YAML frontmatter
```

A full plugin can include any combination of:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Required manifest
├── skills/                   # Skills (preferred over commands/)
│   └── my-skill/
│       └── SKILL.md
├── agents/                   # Specialized subagents
│   └── specialist.md
├── hooks/                    # Event handlers
│   └── hooks.json
└── .mcp.json                # MCP server definitions
```

## Installed Plugin Manifest

Nomos tracks installed plugins in `~/.nomos/plugins/installed.json`:

```json
{
  "version": 1,
  "plugins": [
    {
      "name": "pr-review-toolkit",
      "version": "unknown",
      "marketplace": "claude-plugins-official",
      "source": "plugins",
      "installedAt": "2026-04-15T21:44:17.000Z"
    }
  ]
}
```

## Architecture

### Loading flow

```
daemon boot / CLI start
        │
        ▼
ensureDefaultPlugins()         ← install defaults if missing
        │
        ▼
loadInstalledPlugins()         ← read installed.json + validate dirs
        │
        ▼
toSdkPluginConfigs()           ← map to { type: 'local', path }[]
        │
        ▼
runSession({ plugins })        ← passed to every SDK query() call
        │
        ▼
SDK loads skills/agents/hooks  ← handled by Claude Agent SDK
```

### Source files

| File                          | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `src/plugins/types.ts`        | Type definitions and default plugin list        |
| `src/plugins/loader.ts`       | Read installed manifest, load plugin metadata   |
| `src/plugins/installer.ts`    | Marketplace browsing, install, remove, defaults |
| `src/cli/plugin.ts`           | CLI commands (list, available, install, remove) |
| `src/sdk/session.ts`          | Passes `plugins` to SDK `query()`               |
| `src/daemon/agent-runtime.ts` | Loads plugins at boot, passes to all sessions   |
| `src/daemon/team-runtime.ts`  | Threads plugins to team workers                 |

## Troubleshooting

### No plugins available

Make sure Claude Code is installed and has synced its marketplace. The marketplace clone should exist at `~/.claude/plugins/marketplaces/claude-plugins-official/`. If it doesn't, open Claude Code once — it syncs the marketplace on startup.

### Plugin not loading

1. Check that the plugin directory exists at `~/.nomos/plugins/<name>/`
2. Verify it contains `.claude-plugin/plugin.json`
3. Check `nomos plugin list` to confirm it appears in the installed manifest
4. Restart the daemon — plugins are cached on boot

### Skill namespace conflicts

Plugin skills are namespaced by the SDK as `plugin-name:skill-name`. If a plugin skill conflicts with a bundled Nomos skill, the bundled skill takes precedence in the system prompt, but the plugin skill remains accessible via its namespaced name.

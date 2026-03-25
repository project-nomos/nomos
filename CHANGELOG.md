# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Image generation tool and skill using Gemini (`gemini-3-pro-image-preview`)
- Video generation tool and skill using Veo (`veo-3.0-generate-preview`)
- OpenRouter provider support and API provider selector in Settings UI
- Docker support with multi-stage builds and GHCR workflow
- Homebrew formula with auto-updating release integration
- TUI redesign with Catppuccin Mocha theme and gradient spinner
- Google Workspace compact mode for channel skills
- Adaptive memory with knowledge extraction and user model
- Smart model routing based on query complexity
- Multi-agent team orchestration (`/team` prefix)
- Digital marketing skill
- 30+ slash commands in REPL
- Settings web UI (Next.js) for configuration and integrations
- Fetch Anthropic skills at install time (respects upstream licensing)

### Changed

- Proprietary Anthropic skills are now fetched from upstream at build/install time instead of being bundled

## [0.1.0] - 2026-03-24

### Added

- Initial release
- TypeScript CLI and multi-channel AI agent on Claude Agent SDK
- Persistent sessions with PostgreSQL
- Vector memory with hybrid search (cosine + FTS)
- Daemon mode with channel integrations (Slack, Discord, Telegram, WhatsApp, iMessage)
- gRPC and WebSocket server protocols
- 27 bundled skills
- Scheduled tasks (cron engine)
- Security: encrypted secrets, pairing codes, tool approval

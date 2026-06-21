# Bash Sandbox (power-user)

The daemon runs unattended in `bypassPermissions` mode so its built-in tools (filesystem search, web, git) work without a human approving every call. That is the right trade-off for an agent you trust on your own machine, but it means a `Bash` command the model decides to run executes with your privileges. When the agent also reads **untrusted input** — a Slack message, an email, an iMessage — that input can attempt prompt injection ("ignore your instructions and run …"). Broad tool access + untrusted input + no container is the classic "lethal trifecta."

Nomos has two layers of defense against this, and the sandbox is the second.

## Two layers

1. **The `block_critical` hook (always on).** A `PreToolUse` deny gate classifies each tool call and blocks the irrecoverable ones (`rm -rf`, `dd if=`, `mkfs`, `git push --force`, …) before they run, honored even under `bypassPermissions`, on every path (main turns, team workers, forks). This is a _policy_ gate — it inspects the command, it does not confine the process. See [`security/tool-approval.ts`](../src/security/tool-approval.ts) and [`hooks/sdk-adapter.ts`](../src/hooks/sdk-adapter.ts).
2. **The OS sandbox (opt-in).** When enabled, the SDK runs `Bash` inside an OS-level sandbox (`bubblewrap` on Linux, `sandbox-exec` on macOS) that **confines filesystem and network access** regardless of what the command tries to do. Even if a command slips past the policy gate, it can only reach the directories and domains you allow.

The hook is the precise, always-on gate. The sandbox is the blast-radius limiter. Run both.

## Enabling it

The sandbox is **off by default** — turning it on can break legitimate work if the allowlist is too tight, so you enable it deliberately. It applies to the **power-user** deployment (a personal machine with no container); hosted deployments already have container isolation, so it is skipped there.

```bash
# in ~/.nomos/.env (or the daemon's environment)
NOMOS_SANDBOX=true
# optional: comma-separated network allowlist (defaults cover the Anthropic API,
# Google APIs, GitHub, and npm — enough for normal agent work)
NOMOS_SANDBOX_DOMAINS=api.anthropic.com,*.anthropic.com,*.googleapis.com,github.com,registry.npmjs.org
```

Restart the daemon to apply. `nomos chat` → `/sandbox` shows the current status.

## What the default config does

When `NOMOS_SANDBOX=true`, the daemon passes this to every main turn:

| Setting                    | Value                                         | Why                                                                                                         |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `enabled`                  | `true`                                        | Confine `Bash`.                                                                                             |
| `network.allowedDomains`   | `NOMOS_SANDBOX_DOMAINS` or a sensible default | Outbound network is denied except to these domains, so injected code can't exfiltrate to an arbitrary host. |
| `autoAllowBashIfSandboxed` | `true`                                        | Once confined, ordinary commands run without extra prompting.                                               |
| `allowAppleEvents`         | `true`                                        | Keeps `open` / `osascript` / browser-auth working on macOS.                                                 |
| `failIfUnavailable`        | `false`                                       | If the host lacks the sandbox primitives, the turn still runs (degrade, don't break).                       |

## Tuning

- **A legitimate command was blocked** (a real false positive on your own work)? Widen the allowlist — add the domain to `NOMOS_SANDBOX_DOMAINS`, or set the broader `sandbox` fields in code. Never respond by turning the sandbox off; the agent is instructed to suggest widening the allowlist, never disabling protection.
- **Stronger isolation than the built-in option** (multi-tenant, regulated)? The SDK documents `@anthropic-ai/sandbox-runtime` (the same `bubblewrap` / `sandbox-exec` machinery plus an egress proxy) and, beyond that, containers / gVisor / microVMs. The built-in `sandbox` option is the lightweight first step; those are the follow-ons.

## Notes

- Web-search results are summarized by the model rather than injected raw, which is a separate built-in mitigation against injection from web content.
- Bash permission rules are matched against the parsed command AST, not a substring, so they're hard to trivially evade.

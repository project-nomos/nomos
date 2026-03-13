---
name: self-improve
description: "Clone the Nomos repository, analyze the codebase for improvements, implement changes, and open a pull request. Use when asked to improve itself, contribute to its own codebase, fix its own bugs, add features to itself, write tests for itself, or do self-maintenance. Also triggered by phrases like 'improve yourself', 'fix your code', 'add a feature to nomos', 'update your own repo'."
---

# Self-Improve

Analyze the Nomos codebase, implement improvements, and open a pull request for review.

## Workflow

### Step 1 — Clone

Always work in a fresh clone. Never modify the running instance.

```bash
WORK_DIR=$(mktemp -d)/nomos
git clone git@github.com:meidad/nomos.git "$WORK_DIR"
cd "$WORK_DIR"
```

### Step 2 — Analyze

1. Read `CLAUDE.md` in the cloned repo for project conventions
2. Install dependencies:
   ```bash
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install
   ```
3. Run `pnpm check` to confirm a clean baseline — if the baseline is broken, stop and report to the user
4. Analyze the codebase based on the user's request, or identify improvements self-directed

### Step 3 — Branch

Create a branch from `main`:

```bash
git checkout -b improve/<descriptive-slug>
```

Use descriptive slugs: `improve/add-chunker-edge-case-tests`, `improve/fix-session-cleanup`, etc.

### Step 4 — Implement

- Make focused, single-purpose changes
- Follow project conventions from CLAUDE.md: strict TypeScript, ESM imports with `.ts` extensions, files under 500 LOC, colocated tests
- One PR = one concern — do not bundle unrelated changes
- Include test coverage for any new code

### Step 5 — Verify

All three must pass before proceeding. If any fail, fix before continuing.

```bash
pnpm check       # format + typecheck + lint
pnpm test         # all tests pass
pnpm build        # build succeeds
```

### Step 6 — Commit & Push

```bash
git add <specific-files>
git commit -m "<conventional commit message>"
git push -u origin improve/<slug>
```

### Step 7 — Open PR

```bash
gh pr create \
  --repo meidad/nomos \
  --title "<short title>" \
  --body "## Summary
<what was changed and why>

## Changes
<bulleted list of changes>"
```

### Step 8 — Report

Return the PR URL to the user and summarize what was changed and why.

## Guardrails

- Always work in a fresh clone — never modify the running instance
- Never force push or delete branches
- Never commit secrets, `.env` files, or credentials
- Run all checks before opening the PR
- Keep PRs small and focused — prefer multiple small PRs over one large one
- The PR description should explain the "why" not just the "what"

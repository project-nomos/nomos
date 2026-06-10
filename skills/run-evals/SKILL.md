---
name: run-evals
description: "Run the Nomos eval suite -- recall@5, per-user isolation, and the end-to-end agent eval with the Opus-4.8 DB-content audit + the spec-driven feature-manifest audit. Use /run-evals when asked to run the evals, verify the memory system, check tenant isolation, or audit that features are actually wired and their DB effects land."
emoji: "🧪"
---

# Run Evals

The eval suite verifies three things: the memory system recalls, per-user data never leaks across tenants, and every feature is actually wired and produces the durable DB state it promises. All commands run from the repo root and need a real `DATABASE_URL` (PostgreSQL + pgvector) and a model provider (`ANTHROPIC_API_KEY`, Vertex via `CLAUDE_CODE_USE_VERTEX=1`, or `NOMOS_USE_SUBSCRIPTION=true`).

> On macOS, prefix commands with `PGGSSENCMODE=disable` if you see GSSAPI connection noise.

## Quick reference

| Command                        | What it does                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm eval:audit`              | **The full gate.** Agent eval against a throwaway `nomos_eval`, then the Opus-4.8 label audit + the spec-driven manifest audit, then drops the DB. One process, end-to-end. |
| `pnpm eval:agent`              | Agent eval only (no LLM audit), throwaway DB.                                                                                                                               |
| `pnpm eval:agent --keep`       | Run + keep `nomos_eval` for inspection; also writes a results file.                                                                                                         |
| `pnpm eval:agent --audit-kept` | Audit a kept DB (label + spec audit) without re-running the eval, then drop it.                                                                                             |
| `pnpm eval:agent --clean`      | Drop a kept `nomos_eval`.                                                                                                                                                   |
| `pnpm eval:recall`             | Seed facts, probe retrieval, score recall@5 (regression guard).                                                                                                             |
| `pnpm check:isolation`         | Write as two users through the real functions, assert neither sees the other.                                                                                               |

## When asked to "run the evals"

Default to `PGGSSENCMODE=disable pnpm eval:audit` -- the complete check (eval -> audit -> clean). Then report:

- the deterministic tally (`N ran, M failed`),
- `AUDIT: PASS/FAIL` -- the Opus label audit (DB content vs the passing test labels),
- `SPEC-AUDIT: PASS/FAIL` -- the manifest audit (wiring + effects vs the feature manifest).

To inspect the data instead of dropping it: `--keep`, then `psql "$DATABASE_URL"` against DB `nomos_eval`, then `--audit-kept`, then `--clean`.

## The spec-driven audit + feature manifest

[`eval/feature-manifest.ts`](../../eval/feature-manifest.ts) is an INDEPENDENT contract: per feature, its trigger, `entry` symbols, observable `effects` (checkable SQL), and invariants. `runSpecAudit()` in `eval/agent-eval.ts` checks four layers:

1. **Liveness** (deterministic grep) -- every feature must have a live call site, else `DORMANT`.
2. **Sentinel meta-check** -- every cron sentinel must be handled (cron-engine) AND seeded (gateway) AND declared in the manifest.
3. **Effects + no-double-encode** -- per-feature SQL against the populated DB; the guard flags only jsonb strings whose text is itself JSON.
4. **Opus-4.8 / xhigh reasoning** against the manifest (dormant / missing-effect / drift).

This is the layer that catches dormant code and under-populated columns that no individual test asserts -- the gap the label audit alone cannot see.

### When you add a feature, declare it here

Add a `FEATURES` entry in `eval/feature-manifest.ts` with:

- `trigger` -- `cron` (with `sentinel`) / `turn` / `boot` / `cli`.
- `entry` -- the exported symbol(s) a live path must call. Liveness greps these, so each MUST have a real call site or the audit fails.
- `effects` -- a count-query `sql` (`expect: "nonzero"`) for each durable DB effect; mark `notExercised: true` when the eval does not drive it (evidence-only, never a hard fail). Add a `noDoubleEncode` guard for any jsonb column.
- For a **background (cron)** feature, the meta-check FAILS until the sentinel is both handled and seeded -- declaring it is mandatory, not optional.

Verify a new entry with `pnpm eval:agent --keep`, probe the effect SQL against `nomos_eval`, and only promote an effect to a hard (exercised) check once you confirm it returns nonzero.

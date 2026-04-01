---
name: memory-consolidation
description: Periodic memory maintenance — merges duplicates, prunes stale chunks, decays confidence
schedule: "0 3 * * *"
session-target: isolated
delivery-mode: none
enabled: false
---

Run memory consolidation to keep the memory store clean and relevant.

Use the `memory_consolidate` tool to:

1. Merge near-duplicate memory chunks (>92% similarity)
2. Prune stale chunks with low access count (>7 days old, accessed 0-1 times)
3. Decay user model confidence for entries not reinforced in 30+ days

Report the consolidation results (merged, pruned, total before/after).

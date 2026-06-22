/**
 * Accumulates assistant text by source-message UUID so a refusal-fallback can
 * EVICT the refused partial from the final turn text.
 *
 * Once a `fallbackModel` is wired (Phase A.2), the SDK can refuse on the primary
 * model and retry on a fallback. It signals the retraction two ways (both
 * idempotent): the replacement assistant message carries `supersedes` (evict on
 * arrival), and the end-of-turn `model_refusal_fallback` system notice carries
 * `retracted_message_uuids` (the complete audit record). Without eviction the
 * refused partial would linger in `fullText`/the transcript.
 *
 * `toString()` reproduces the previous raw-concat semantics EXACTLY when nothing
 * is evicted (single "\n" between text blocks, only when not already newline-
 * terminated), so the common no-refusal path is byte-identical to before.
 */
export class AssistantText {
  private blocks: Array<{ uuid: string; text: string }> = [];

  /** Append a text block produced by the assistant message identified by `uuid`. */
  add(uuid: string, text: string): void {
    if (!text) return;
    this.blocks.push({ uuid, text });
  }

  /** Evict superseded/retracted messages by uuid (idempotent; unknown = no-op). */
  evict(uuids: readonly string[] | undefined): void {
    if (!uuids?.length) return;
    const drop = new Set(uuids);
    this.blocks = this.blocks.filter((b) => !drop.has(b.uuid));
  }

  /** Replace everything with a single result string (compaction fallback path). */
  setResult(text: string): void {
    this.blocks = text ? [{ uuid: "__result__", text }] : [];
  }

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  toString(): string {
    let out = "";
    for (const b of this.blocks) {
      if (!b.text) continue;
      if (out && !out.endsWith("\n")) out += "\n";
      out += b.text;
    }
    return out;
  }
}

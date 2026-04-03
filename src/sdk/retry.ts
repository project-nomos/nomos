/**
 * Retry logic with adaptive backoff.
 *
 * Provides smart retry strategies for API calls with:
 * - Exponential backoff with jitter
 * - Retry-after header support
 * - 429 (rate limit) and 529 (overloaded) handling
 * - Configurable max retries
 * - Optional persistent retry mode for unattended/daemon sessions
 *
 * Adapted from Claude Code's withRetry.ts — simplified to remove
 * product-specific auth flows and fast-mode logic.
 */

/** Base delay for first retry. */
const BASE_DELAY_MS = 500;

/** Default maximum number of retries. */
const DEFAULT_MAX_RETRIES = 8;

/** Maximum delay between retries (32 seconds). */
const DEFAULT_MAX_DELAY_MS = 32_000;

/** Maximum delay for persistent mode (5 minutes). */
const PERSISTENT_MAX_DELAY_MS = 5 * 60 * 1000;

/** Maximum total wait for persistent retry (6 hours). */
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000;

export interface RetryOptions {
  /** Maximum number of retries before giving up. */
  maxRetries?: number;
  /** Enable persistent retry for unattended sessions (retries indefinitely on 429/529). */
  persistent?: boolean;
  /** AbortSignal to cancel retries. */
  signal?: AbortSignal;
  /** Called before each retry with delay info. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export class RetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly attempts: number,
  ) {
    const msg = originalError instanceof Error ? originalError.message : String(originalError);
    super(`Failed after ${attempts} attempts: ${msg}`);
    this.name = "RetryError";
  }
}

/**
 * Execute an async operation with retry logic.
 *
 * Retries on:
 * - HTTP 429 (rate limit)
 * - HTTP 529 (overloaded)
 * - HTTP 408 (timeout)
 * - HTTP 5xx (server errors)
 * - Connection errors (ECONNRESET, EPIPE, etc.)
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let lastError: unknown;

  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) {
      throw new Error("Aborted");
    }

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const isPersistentCapacity = options.persistent && isTransientCapacityError(error);

      if (attempt > maxRetries && !isPersistentCapacity) {
        throw new RetryError(error, attempt);
      }

      if (!isRetryableError(error)) {
        throw error;
      }

      // Calculate delay
      const retryAfterMs = getRetryAfterMs(error);
      const maxDelay = options.persistent ? PERSISTENT_MAX_DELAY_MS : DEFAULT_MAX_DELAY_MS;
      let delayMs: number;

      if (isPersistentCapacity) {
        // Persistent mode: use retry-after or exponential backoff
        const resetDelay = getRateLimitResetMs(error);
        delayMs = resetDelay ?? retryAfterMs ?? getExponentialDelay(attempt, maxDelay);
        delayMs = Math.min(delayMs, PERSISTENT_RESET_CAP_MS);
      } else {
        delayMs = retryAfterMs ?? getExponentialDelay(attempt, maxDelay);
      }

      options.onRetry?.(attempt, delayMs, error);

      // Wait before retrying
      await sleep(delayMs, options.signal);

      // In persistent mode, don't let attempt exceed maxRetries
      // (prevents the for-loop from terminating)
      if (isPersistentCapacity && attempt >= maxRetries) {
        attempt = maxRetries;
      }
    }
  }

  throw new RetryError(lastError, maxRetries + 1);
}

/**
 * Calculate exponential backoff delay with jitter.
 */
export function getExponentialDelay(attempt: number, maxDelayMs = DEFAULT_MAX_DELAY_MS): number {
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs);
  const jitter = Math.random() * 0.25 * baseDelay;
  return Math.round(baseDelay + jitter);
}

// ── Error Classification ──

interface ErrorLike {
  status?: number;
  message?: string;
  code?: string;
  headers?: Headers | Record<string, string>;
  cause?: { code?: string };
}

/**
 * Check if an error is a transient capacity error (429/529).
 */
function isTransientCapacityError(error: unknown): boolean {
  const e = error as ErrorLike;
  return e.status === 429 || e.status === 529 || is529Error(error);
}

/**
 * Check if an error is a 529 (overloaded) by status or message content.
 */
function is529Error(error: unknown): boolean {
  const e = error as ErrorLike;
  if (e.status === 529) return true;
  // SDK sometimes doesn't propagate 529 status — check message
  if (e.message?.includes('"type":"overloaded_error"')) return true;
  return false;
}

/**
 * Check if an error is retryable.
 */
function isRetryableError(error: unknown): boolean {
  const e = error as ErrorLike;

  // Connection errors
  if (isConnectionError(error)) return true;

  const status = e.status;
  if (!status) return false;

  // Rate limit
  if (status === 429) return true;
  // Overloaded
  if (status === 529) return true;
  // Timeout
  if (status === 408) return true;
  // Conflict (lock timeout)
  if (status === 409) return true;
  // Server errors
  if (status >= 500) return true;

  // 529 detected via message
  if (is529Error(error)) return true;

  return false;
}

/**
 * Check if an error is a connection error.
 */
function isConnectionError(error: unknown): boolean {
  const e = error as ErrorLike;
  const code = e.code ?? e.cause?.code;
  if (!code) return false;

  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND"
  );
}

// ── Header Parsing ──

function getRetryAfterMs(error: unknown): number | null {
  const e = error as ErrorLike;
  const headerValue = getHeaderValue(e.headers, "retry-after");
  if (!headerValue) return null;

  const seconds = parseInt(headerValue, 10);
  if (isNaN(seconds)) return null;
  return seconds * 1000;
}

function getRateLimitResetMs(error: unknown): number | null {
  const e = error as ErrorLike;
  const resetHeader = getHeaderValue(e.headers, "anthropic-ratelimit-unified-reset");
  if (!resetHeader) return null;

  const resetUnixSec = Number(resetHeader);
  if (!Number.isFinite(resetUnixSec)) return null;

  const delayMs = resetUnixSec * 1000 - Date.now();
  if (delayMs <= 0) return null;
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS);
}

function getHeaderValue(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  return (headers as Record<string, string>)[name] ?? null;
}

// ── Sleep ──

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

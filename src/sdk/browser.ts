/**
 * Browser lifecycle manager for headless page fetching.
 *
 * Uses Playwright's Chromium to render JavaScript-heavy pages.
 * The browser is lazily initialized on first use and reused across requests.
 */

import type { Browser, Page } from "playwright";

let browser: Browser | null = null;

/** Launch or return the existing headless Chromium instance. */
export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });

  // Clean up on process exit
  const cleanup = () => {
    browser?.close().catch(() => {});
    browser = null;
  };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  return browser;
}

/** Close the browser instance. Safe to call multiple times. */
export async function closeBrowser(): Promise<void> {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    // Already closed or crashed — ignore
  }
  browser = null;
}

export interface FetchOptions {
  /** CSS selector to wait for before extracting content */
  waitForSelector?: string;
  /** Extra milliseconds to wait after page load */
  waitForTimeout?: number;
  /** Navigation timeout in milliseconds (default: 30000) */
  timeout?: number;
}

export interface FetchResult {
  title: string;
  content: string;
  error?: string;
}

/** Navigate to a URL, render JS, and extract text content. */
export async function fetchRenderedPage(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const instance = await getBrowser();
  let page: Page | null = null;

  try {
    page = await instance.newPage();

    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: options.timeout ?? 30_000,
    });

    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, {
        timeout: options.timeout ?? 30_000,
      });
    }

    if (options.waitForTimeout) {
      await page.waitForTimeout(options.waitForTimeout);
    }

    // Strip non-content elements before extracting text
    // eslint-disable-next-line no-eval -- runs in browser context, not Node
    await page.evaluate(`(() => {
      for (const tag of ["script", "style", "noscript"]) {
        document.querySelectorAll(tag).forEach(el => el.remove());
      }
    })()`);

    const [title, content] = await Promise.all([
      page.title(),
      page.evaluate(`document.body?.innerText ?? ""`) as Promise<string>,
    ]);

    return { title, content };
  } finally {
    await page?.close().catch(() => {});
  }
}

/** Block dangerous or private URLs unless explicitly allowed. */
export function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return `Blocked protocol: ${parsed.protocol} — only http and https are allowed`;
  }

  const allowLocal = process.env.BROWSER_FETCH_ALLOW_LOCAL === "1";
  if (!allowLocal) {
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    ) {
      return `Blocked local URL: ${host} — set BROWSER_FETCH_ALLOW_LOCAL=1 to allow`;
    }
  }

  return null;
}

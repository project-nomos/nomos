/**
 * Browser lifecycle manager with interactive control.
 *
 * Uses Playwright's Chromium for both headless page fetching and
 * full interactive browser automation (click, type, screenshot, evaluate).
 * The browser is lazily initialized on first use and reused across requests.
 * A persistent page is maintained for interactive sessions.
 */

import type { Browser, Page } from "playwright";

let browser: Browser | null = null;

/** Persistent page for interactive browser sessions. */
let activePage: Page | null = null;

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

// ── Interactive browser session ──

/** Get or create the persistent interactive page. */
export async function getActivePage(): Promise<Page> {
  if (activePage && !activePage.isClosed()) return activePage;
  const instance = await getBrowser();
  activePage = await instance.newPage();
  return activePage;
}

/** Navigate the active page to a URL. */
export async function browserNavigate(
  url: string,
  options: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number } = {},
): Promise<{ title: string; url: string }> {
  const page = await getActivePage();
  await page.goto(url, {
    waitUntil: options.waitUntil ?? "networkidle",
    timeout: options.timeout ?? 30_000,
  });
  return { title: await page.title(), url: page.url() };
}

/** Take a screenshot of the active page. Returns base64-encoded PNG. */
export async function browserScreenshot(options: {
  fullPage?: boolean;
  selector?: string;
}): Promise<{ base64: string; width: number; height: number }> {
  const page = await getActivePage();

  let buffer: Buffer;
  if (options.selector) {
    const el = await page.$(options.selector);
    if (!el) throw new Error(`Selector not found: ${options.selector}`);
    buffer = await el.screenshot({ type: "png" });
  } else {
    buffer = await page.screenshot({
      type: "png",
      fullPage: options.fullPage ?? false,
    });
  }

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  return {
    base64: buffer.toString("base64"),
    width: viewport.width,
    height: viewport.height,
  };
}

/** Click an element on the active page. */
export async function browserClick(
  selector: string,
  options: { button?: "left" | "right" | "middle"; clickCount?: number; timeout?: number } = {},
): Promise<{ clicked: boolean; text?: string }> {
  const page = await getActivePage();
  await page.click(selector, {
    button: options.button ?? "left",
    clickCount: options.clickCount ?? 1,
    timeout: options.timeout ?? 5_000,
  });
  // Return the text content of what was clicked for context
  const text =
    ((await page
      .evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.innerText?.slice(0, 200) ?? ""`,
      )
      .catch(() => "")) as string) || undefined;
  return { clicked: true, text };
}

/** Type text into an element on the active page. */
export async function browserType(
  selector: string,
  text: string,
  options: { clear?: boolean; delay?: number; pressEnter?: boolean } = {},
): Promise<{ typed: boolean }> {
  const page = await getActivePage();
  if (options.clear) {
    await page.fill(selector, "");
  }
  await page.type(selector, text, { delay: options.delay ?? 50 });
  if (options.pressEnter) {
    await page.press(selector, "Enter");
  }
  return { typed: true };
}

/** Select an option from a <select> element. */
export async function browserSelect(
  selector: string,
  values: string[],
): Promise<{ selected: string[] }> {
  const page = await getActivePage();
  const selected = await page.selectOption(selector, values);
  return { selected };
}

/** Evaluate JavaScript in the active page context. */
export async function browserEvaluate(expression: string): Promise<unknown> {
  const page = await getActivePage();
  return page.evaluate(expression);
}

/** Get all visible text and interactive elements on the active page. */
export async function browserSnapshot(): Promise<{
  title: string;
  url: string;
  text: string;
  elements: Array<{ tag: string; text: string; selector: string; type?: string }>;
}> {
  const page = await getActivePage();

  const [title, url, text, elements] = await Promise.all([
    page.title(),
    Promise.resolve(page.url()),
    page.evaluate(`(() => {
      for (const tag of ["script", "style", "noscript"]) {
        document.querySelectorAll(tag).forEach(el => el.remove());
      }
      return document.body?.innerText ?? "";
    })()`) as Promise<string>,
    page.evaluate(`(() => {
      const interactable = ['a', 'button', 'input', 'select', 'textarea', '[role="button"]', '[onclick]'];
      const elements = [];
      for (const sel of interactable) {
        document.querySelectorAll(sel).forEach((el, i) => {
          const tag = el.tagName.toLowerCase();
          const text = (el.innerText || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').slice(0, 100);
          if (!text.trim() && tag !== 'input') return;
          const id = el.id ? '#' + el.id : '';
          const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
          const selector = id || (tag + cls) || tag + ':nth-of-type(' + (i + 1) + ')';
          elements.push({ tag, text: text.trim(), selector, type: el.getAttribute('type') || undefined });
        });
      }
      return elements.slice(0, 50);
    })()`) as Promise<Array<{ tag: string; text: string; selector: string; type?: string }>>,
  ]);

  return { title, url, text: text.slice(0, 5000), elements };
}

/** Close the active interactive page (not the browser). */
export async function closeActivePage(): Promise<void> {
  if (!activePage) return;
  try {
    await activePage.close();
  } catch {
    // Already closed
  }
  activePage = null;
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

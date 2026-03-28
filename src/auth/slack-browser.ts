/**
 * Slack browser-based authentication.
 *
 * Launches a Playwright browser, lets the user sign into Slack,
 * and intercepts API requests to capture xoxc- session tokens.
 * Works without any Slack app — just a browser session.
 *
 * Used by both the CLI (`nomos slack auth`) and Settings UI API.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export interface CapturedWorkspace {
  token: string;
  teamId: string;
  teamName: string;
  userId: string;
  cookie: string;
}

export interface BrowserAuthCallbacks {
  /** Called when a workspace is successfully captured. */
  onCapture?: (ws: CapturedWorkspace) => void;
  /** Called with status messages. */
  onStatus?: (message: string) => void;
  /** Called on timeout with no captures. */
  onTimeout?: () => void;
}

/**
 * Launch browser, let user sign into Slack, capture tokens.
 *
 * Returns all captured workspaces. The browser closes automatically
 * after tokens are captured (with a 5s debounce for multi-workspace)
 * or after a 2-minute timeout.
 */
export async function captureSlackTokensViaBrowser(
  callbacks?: BrowserAuthCallbacks,
): Promise<CapturedWorkspace[]> {
  const { chromium } = await import("playwright");

  // Fresh browser context — forces login flow which reliably exposes tokens
  const browser = await chromium.launch({
    headless: false,
    channel: "chromium",
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  const captured = new Map<string, CapturedWorkspace>();
  const failedTokens = new Set<string>();
  let resolveCapture: () => void;
  let captureTimer: ReturnType<typeof setTimeout>;

  const capturePromise = new Promise<void>((resolve) => {
    resolveCapture = resolve;
  });

  // Debounce: after capturing a token, wait 5s for more, then resolve
  function scheduleResolve() {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => resolveCapture(), 5000);
  }

  // Intercept ALL requests to capture xoxc- tokens from body, headers, or URL
  page.on("request", async (request) => {
    let token: string | null = null;

    // Check POST body (URL-encoded, multipart form data, or JSON)
    const postData = request.postData();
    if (postData) {
      // URL-encoded: token=xoxc-...
      const formMatch = postData.match(/token=(xoxc-[^\s&"']+)/);
      if (formMatch) token = decodeURIComponent(formMatch[1]);

      // Multipart: name="token"\r\n\r\nxoxc-...
      if (!token) {
        const multipartMatch = postData.match(/name="token"\s+\n?(xoxc-[^\s\r\n-]+[a-zA-Z0-9])/);
        if (multipartMatch) token = multipartMatch[1];
      }

      // JSON: "token": "xoxc-..."
      if (!token) {
        const jsonMatch = postData.match(/"token"\s*:\s*"(xoxc-[^"]+)"/);
        if (jsonMatch) token = jsonMatch[1];
      }

      // Fallback: any xoxc- token anywhere in the body
      if (!token) {
        const anyMatch = postData.match(/xoxc-[a-zA-Z0-9_-]{50,}/);
        if (anyMatch) token = anyMatch[0];
      }
    }

    // Check Authorization header
    if (!token) {
      const authHeader = request.headers().authorization;
      if (authHeader?.includes("xoxc-")) {
        const headerMatch = authHeader.match(/(xoxc-[^\s]+)/);
        if (headerMatch) token = headerMatch[1];
      }
    }

    if (!token || captured.has(token) || failedTokens.has(token)) return;

    // Get the d cookie from the browser context and validate token via Node fetch
    try {
      // Collect cookies from all Slack domains
      const urls = ["https://slack.com", "https://app.slack.com"];
      const reqUrl = request.url();
      const domainMatch = reqUrl.match(/https:\/\/([^/]+\.slack\.com)/);
      if (domainMatch) urls.push(`https://${domainMatch[1]}`);

      const allCookies = (await Promise.all(urls.map((u) => context.cookies(u)))).flat();
      const dCookie = allCookies.find((c) => c.name === "d");
      if (!dCookie) return;

      // Use Node's fetch to call auth.test
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `d=${dCookie.value}`,
        },
        body: `token=${token}`,
      });

      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        team_id?: string;
        team?: string;
        user_id?: string;
        user?: string;
      };

      if (data.ok && data.team_id && !captured.has(token)) {
        const ws: CapturedWorkspace = {
          token,
          teamId: data.team_id,
          teamName: data.team ?? "unknown",
          userId: data.user_id ?? "unknown",
          cookie: dCookie.value,
        };
        captured.set(token, ws);
        callbacks?.onCapture?.(ws);
        scheduleResolve();
      } else if (!data.ok) {
        failedTokens.add(token);
      }
    } catch {
      // Silently skip — stale or invalid tokens are expected during login flow
    }
  });

  // Read workspace domains from Slack desktop app data (if available)
  const slackDirs = [
    path.join(
      homedir(),
      "Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack",
    ),
    path.join(homedir(), "Library/Application Support/Slack"),
  ];
  const slackDir = slackDirs.find((d) => fs.existsSync(d));
  let workspaceDomains: string[] = [];
  if (slackDir) {
    try {
      const rootState = JSON.parse(
        fs.readFileSync(path.join(slackDir, "storage", "root-state.json"), "utf8"),
      );
      const workspaces = rootState.workspaces as Record<string, { domain?: string }> | undefined;
      if (workspaces) {
        workspaceDomains = Object.values(workspaces)
          .map((ws) => ws.domain)
          .filter((d): d is string => !!d);
      }
    } catch {
      // Skip
    }
  }

  // Navigate to sign-in or first known workspace
  const startUrl =
    workspaceDomains.length > 0
      ? `https://${workspaceDomains[0]}.slack.com`
      : "https://slack.com/signin";

  // Helper: try to extract xoxc- token from the page and validate it.
  // Uses multiple strategies since Slack's JS globals change between versions.
  async function tryExtractTokenFromPage(): Promise<boolean> {
    try {
      // Strategy 1: Extract from page JS context (various known locations)
      const token = (await page.evaluate(`
        (() => {
          try {
            // boot_data global (classic Slack web)
            if (window.boot_data?.api_token?.startsWith("xoxc-")) return window.boot_data.api_token;
            if (window.TS?.boot_data?.api_token?.startsWith("xoxc-")) return window.TS.boot_data.api_token;
            // Redux store or similar
            if (window.__STORE__) {
              const state = window.__STORE__.getState?.();
              if (state?.auth?.token?.startsWith("xoxc-")) return state.auth.token;
            }
            // localStorage
            try {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                const val = localStorage.getItem(key) ?? "";
                const m = val.match(/xoxc-[a-zA-Z0-9_-]{50,}/);
                if (m) return m[0];
              }
            } catch {}
            // Embedded in page HTML
            const html = document.documentElement?.innerHTML ?? "";
            const m = html.match(/"api_token"\\s*:\\s*"(xoxc-[^"]+)"/);
            if (m) return m[1];
            // Any xoxc- token in the page
            const fallback = html.match(/xoxc-[a-zA-Z0-9_-]{50,}/);
            if (fallback) return fallback[0];
          } catch {}
          return null;
        })()
      `)) as string | null;

      if (token && !captured.has(token) && !failedTokens.has(token)) {
        // Get cookie and validate
        const allCookies = (
          await Promise.all(
            ["https://slack.com", "https://app.slack.com"].map((u) => context.cookies(u)),
          )
        ).flat();
        const dCookie = allCookies.find((c) => c.name === "d");
        if (!dCookie) return false;

        const res = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: `d=${dCookie.value}`,
          },
          body: `token=${token}`,
        });

        const data = (await res.json()) as {
          ok?: boolean;
          team_id?: string;
          team?: string;
          user_id?: string;
          user?: string;
        };

        if (data.ok && data.team_id) {
          const ws: CapturedWorkspace = {
            token,
            teamId: data.team_id,
            teamName: data.team ?? "unknown",
            userId: data.user_id ?? "unknown",
            cookie: dCookie.value,
          };
          captured.set(token, ws);
          callbacks?.onCapture?.(ws);
          return true;
        } else if (!data.ok) {
          failedTokens.add(token);
        }
      }

      // Strategy 2: Use the d cookie to call Slack's client.boot API
      // which returns the xoxc- token for the current workspace
      if (!token || failedTokens.has(token ?? "")) {
        const allCookies = (
          await Promise.all(
            ["https://slack.com", "https://app.slack.com"].map((u) => context.cookies(u)),
          )
        ).flat();
        const dCookie = allCookies.find((c) => c.name === "d");
        if (!dCookie) return false;

        const bootRes = (await page.evaluate(`
          fetch("/api/auth.findSession", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "token=undefined"
          }).then(r => r.text()).catch(() => null)
        `)) as string | null;

        if (bootRes) {
          const bootMatch = bootRes.match(/xoxc-[a-zA-Z0-9_-]{50,}/);
          if (bootMatch && !captured.has(bootMatch[0]) && !failedTokens.has(bootMatch[0])) {
            const foundToken = bootMatch[0];
            const res = await fetch("https://slack.com/api/auth.test", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Cookie: `d=${dCookie.value}`,
              },
              body: `token=${foundToken}`,
            });
            const data = (await res.json()) as {
              ok?: boolean;
              team_id?: string;
              team?: string;
              user_id?: string;
              user?: string;
            };
            if (data.ok && data.team_id) {
              const ws: CapturedWorkspace = {
                token: foundToken,
                teamId: data.team_id,
                teamName: data.team ?? "unknown",
                userId: data.user_id ?? "unknown",
                cookie: dCookie.value,
              };
              captured.set(foundToken, ws);
              callbacks?.onCapture?.(ws);
              return true;
            }
          }
        }
      }
    } catch {
      // Page might not be on a Slack workspace page
    }
    return false;
  }

  await page.goto(startUrl);
  callbacks?.onStatus?.("Browser opened — sign in to Slack");

  // Wait for the user to sign in and capture the first token,
  // then enumerate other known workspaces.
  const waitForFirstCapture = async () => {
    // Wait for the user to sign in — poll until first token is captured
    // The request interceptor handles capture automatically during login
    for (let i = 0; i < 120 && captured.size === 0; i++) {
      await page.waitForTimeout(1000);

      // Every 10s, try extracting from page JS (in case interceptor missed it)
      if (i > 0 && i % 10 === 0 && captured.size === 0) {
        await tryExtractTokenFromPage();
      }
    }

    if (captured.size === 0) return;

    // First workspace captured! Now try other known workspace domains
    if (workspaceDomains.length > 1) {
      for (const domain of workspaceDomains) {
        callbacks?.onStatus?.(`Checking ${domain}.slack.com...`);
        await page.goto(`https://${domain}.slack.com`, { waitUntil: "networkidle" });
        await page.waitForTimeout(5000);
        await tryExtractTokenFromPage();
      }
    }

    resolveCapture();
  };

  waitForFirstCapture().catch(() => {});

  // Wait for captures or timeout
  const timeout = setTimeout(async () => {
    if (captured.size > 0) {
      resolveCapture();
    } else {
      callbacks?.onTimeout?.();
      await browser.close();
    }
  }, 120_000);

  await capturePromise;
  clearTimeout(timeout);
  await browser.close();

  return [...captured.values()];
}

/**
 * Capture tokens via browser and store all workspaces in DB.
 * Returns the list of stored workspaces.
 */
export async function browserAuthAndStore(
  callbacks?: BrowserAuthCallbacks,
): Promise<CapturedWorkspace[]> {
  const workspaces = await captureSlackTokensViaBrowser(callbacks);

  if (workspaces.length === 0) return [];

  const { upsertWorkspace, syncSlackConfigToFile } = await import("../db/slack-workspaces.ts");

  for (const ws of workspaces) {
    await upsertWorkspace({
      teamId: ws.teamId,
      teamName: ws.teamName,
      userId: ws.userId,
      accessToken: ws.token,
      scopes: "browser-session",
      cookie: ws.cookie,
    });
  }

  await syncSlackConfigToFile();
  return workspaces;
}

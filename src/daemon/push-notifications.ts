/**
 * Expo Push Notifications fan-out.
 *
 * The DraftManager / CATE inbound writer / commitment tracker call
 * `notifyUser(userId, {title, body, data})` and we look up the user's
 * registered devices and POST to Expo's HTTPS push endpoint.
 *
 * Stale tokens (Expo returns DeviceNotRegistered) are pruned automatically.
 */

import { getKysely } from "../db/client.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("push");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoResponse {
  data?: ExpoTicket[];
}

/**
 * Whether the user has at least one registered mobile device — i.e. the hosted app's
 * push channel exists. Used to cost-gate proactive work that can only reach the user
 * through the Nomos mobile app.
 */
export async function hasRegisteredDevice(userId: string): Promise<boolean> {
  const db = getKysely();
  const row = await db
    .selectFrom("mobile_devices")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return Number(row?.n ?? 0) > 0;
}

export async function notifyUser(userId: string, payload: PushPayload): Promise<void> {
  const db = getKysely();
  const rows = await db
    .selectFrom("mobile_devices")
    .select(["expo_push_token", "platform"])
    .where("user_id", "=", userId)
    .execute();
  if (rows.length === 0) return;

  const tokens = rows.map((r) => r.expo_push_token);
  await sendExpoPush(tokens, payload);
}

async function sendExpoPush(tokens: string[], payload: PushPayload): Promise<void> {
  const messages = tokens.map((to) => ({
    to,
    sound: "default" as const,
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
  }));

  try {
    const r = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "gzip, deflate",
      },
      body: JSON.stringify(messages),
    });
    if (!r.ok) {
      log.warn({ status: r.status }, "Expo push HTTP non-2xx");
      return;
    }
    const json = (await r.json()) as ExpoResponse;
    if (!json.data) return;

    // Prune tokens that Expo says are stale.
    const stale: string[] = [];
    json.data.forEach((ticket, idx) => {
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        stale.push(tokens[idx]);
      }
    });
    if (stale.length > 0) {
      await pruneStaleTokens(stale);
    }
  } catch (err) {
    log.error({ err }, "Expo push send failed");
  }
}

async function pruneStaleTokens(tokens: string[]): Promise<void> {
  const db = getKysely();
  await db.deleteFrom("mobile_devices").where("expo_push_token", "in", tokens).execute();
  log.info({ count: tokens.length }, "Pruned stale Expo push tokens");
}

export async function registerDevice(
  userId: string,
  args: { expoPushToken: string; platform: "ios" | "android"; appVersion?: string },
): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("mobile_devices")
    .values({
      user_id: userId,
      expo_push_token: args.expoPushToken,
      platform: args.platform,
      app_version: args.appVersion ?? null,
    })
    .onConflict((oc) =>
      oc.column("expo_push_token").doUpdateSet({
        user_id: userId,
        platform: args.platform,
        app_version: args.appVersion ?? null,
        last_seen_at: new Date(),
      }),
    )
    .execute();
}

export async function unregisterDevice(expoPushToken: string): Promise<void> {
  const db = getKysely();
  await db.deleteFrom("mobile_devices").where("expo_push_token", "=", expoPushToken).execute();
}

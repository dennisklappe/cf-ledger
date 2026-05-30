/**
 * cf-ledger Worker.
 *
 *   GET  /api/costs?month=YYYY-MM  -> CostReport for a month
 *   GET  /api/trends               -> month-over-month totals (for the chart)
 *   GET  /api/months               -> months that have data
 *   GET  /api/status               -> connection status (masked)
 *   POST /api/connect              -> validate + store CF token/account (UI login)
 *   POST /api/disconnect           -> clear UI-stored credentials
 *   POST /api/refresh              -> run a snapshot now (today, + yesterday)
 *   *                              -> static dashboard from the ASSETS binding
 *
 * A daily cron also runs the snapshot. The dashboard route is expected to sit
 * behind Cloudflare Access (configured in the dashboard, not here).
 */

import { collectRange } from "./collect";
import { SnapshotStore } from "./db/snapshots";
import { buildReport } from "./cost/attribute";
import { getCreds, connect, disconnect, connectionStatus } from "./config";
import { ensureSchema } from "./db/migrate";
import { checkAccess } from "./auth";
import type { CostReport } from "./types";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Default month = current UTC month. */
function currentMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** A CostReport plus the freshness/mode metadata the dashboard needs. */
type ApiReport = CostReport & {
  lastUpdated: string | null;
  collectionGaps: string[];
  mode: "month" | "range";
  listPrice: boolean;
};

/** Accurate monthly report. `applyFree` toggles the free-allowance (billed) view. */
async function reportForMonth(store: SnapshotStore, month: string, applyFree: boolean): Promise<ApiReport> {
  const usage = await store.readMonth(month);
  const report = buildReport(month, usage.resources, usage.bindings, {
    applyFreeAllowance: applyFree,
    includePlatformFee: true,
  });
  return { ...report, lastUpdated: usage.lastUpdated, collectionGaps: usage.gaps, mode: "month", listPrice: !applyFree };
}

/** List-price report for an arbitrary day range (free tiers are monthly, so off). */
async function reportForRange(store: SnapshotStore, from: string, to: string): Promise<ApiReport> {
  const usage = await store.readRange(from, to);
  const label = from === to ? from : `${from} to ${to}`;
  const report = buildReport(label, usage.resources, usage.bindings, {
    applyFreeAllowance: false,
    includePlatformFee: false,
  });
  return { ...report, lastUpdated: usage.lastUpdated, collectionGaps: usage.gaps, mode: "range", listPrice: true };
}

/** Snapshot the `days` most recent days (today back) and store them. */
async function runSnapshot(env: Env, days: number): Promise<{ day: string; status: string }[]> {
  const store = new SnapshotStore(env.DB);
  const c = await getCreds(env);
  if (!c) {
    throw new Error("Not connected. Click Connect in the dashboard, or set CF_API_TOKEN / CF_ACCOUNT_ID secrets.");
  }
  const snaps = await collectRange(c, days, new Date());
  for (const snap of snaps) await store.write(snap);
  return snaps.map((s) => ({ day: s.day, status: s.status }));
}

/** Cloudflare retains ~30 days of analytics; backfill the whole window. */
const BACKFILL_DAYS = 30;

/** Parse a JSON request body, tolerating empty/invalid bodies. */
async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const store = new SnapshotStore(env.DB);

    try {
      await ensureSchema(env.DB);

      // Cloudflare Access enforcement. Fails closed when configured.
      const auth = await checkAccess(request, env);
      if (!auth.ok) return json({ error: auth.reason ?? "Access denied." }, 403);

      if (pathname === "/api/status") {
        // Only warn "unprotected" when actually deployed. Local dev is private.
        const host = url.hostname;
        const local = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
        return json({ ...(await connectionStatus(env)), protected: auth.protected || local });
      }

      if (pathname === "/api/costs") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (from && to) {
          return json(await reportForRange(store, from, to));
        }
        const month = url.searchParams.get("month") || currentMonth(new Date());
        // free=0 -> list-price view (no free allowance). Default billed (free=1).
        const applyFree = url.searchParams.get("free") !== "0";
        return json(await reportForMonth(store, month, applyFree));
      }

      if (pathname === "/api/months") {
        return json({ months: await store.listMonths() });
      }

      if (pathname === "/api/trends") {
        const months = await store.listMonths();
        const trends = [];
        for (const m of months.slice(0, 12).reverse()) {
          const r = buildReport(m, ...(await usageTuple(store, m)));
          trends.push({
            month: m,
            totalUsd: r.totalUsd,
            usageUsd: r.usageUsd,
            apps: r.apps.map((a) => ({ app: a.app, group: a.group, totalUsd: a.totalUsd })),
          });
        }
        return json({ trends });
      }

      if (pathname === "/api/connect" && request.method === "POST") {
        const { token, accountId } = await body<{ token?: string; accountId?: string }>(request);
        try {
          await connect(env, token ?? "", accountId ?? "");
        } catch (e) {
          return json({ ok: false, error: (e as Error).message }, 400);
        }
        return json({ ok: true, status: await connectionStatus(env) });
      }

      if (pathname === "/api/disconnect" && request.method === "POST") {
        await disconnect(env);
        return json({ ok: true });
      }

      if (pathname === "/api/refresh" && request.method === "POST") {
        // Backfill the full retained window so the current month is complete,
        // including spikes that happened before you first connected.
        const days = Number(url.searchParams.get("days")) || BACKFILL_DAYS;
        return json({ snapshots: await runSnapshot(env, Math.min(Math.max(days, 1), 31)) });
      }

      // Everything else -> the static dashboard.
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Re-snapshot yesterday (now complete) and today (partial, refreshed daily).
    ctx.waitUntil(ensureSchema(env.DB).then(() => runSnapshot(env, 2)).then(() => undefined));
  },
};

/** Small helper so /api/trends can spread into buildReport. */
async function usageTuple(
  store: SnapshotStore,
  month: string,
): Promise<[Parameters<typeof buildReport>[1], Parameters<typeof buildReport>[2]]> {
  const u = await store.readMonth(month);
  return [u.resources, u.bindings];
}

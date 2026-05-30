/**
 * Orchestrates snapshots: inventory + bindings (REST) fused with usage
 * (GraphQL) into DaySnapshots.
 *
 * Inventory (which Workers/KV/R2/D1 exist, and the binding graph) is fetched
 * ONCE and reused across every day in a range, so a 30-day backfill costs one
 * inventory pass plus one cheap GraphQL usage query per day, not 30 full passes.
 */

import { RestClient, type InventoryItem } from "./cloudflare/rest";
import { GraphqlClient } from "./cloudflare/graphql";
import type { BindingGraph, ResourceUsage } from "./types";
import type { DaySnapshot } from "./db/snapshots";

export interface Creds {
  accountId: string;
  token: string;
}

/** "YYYY-MM-DD" in UTC for a Date. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build the [start, end) window for a calendar day, clamped to `now` if today. */
function dayWindow(day: string, now: Date): { start: string; end: string } {
  const start = `${day}T00:00:00Z`;
  const endOfDay = new Date(`${day}T00:00:00Z`);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
  const end = endOfDay > now ? now.toISOString() : endOfDay.toISOString();
  return { start, end };
}

interface Inventory {
  items: InventoryItem[];
  bindings: BindingGraph;
  gaps: string[];
}

/** Fetch the account inventory and binding graph once. Faults become gaps. */
async function fetchInventory(rest: RestClient): Promise<Inventory> {
  const items: InventoryItem[] = [];
  const gaps: string[] = [];
  let bindings: BindingGraph = {};

  try {
    const workers = await rest.listWorkers();
    for (const w of workers) items.push({ kind: "worker", id: w.name, name: w.name });
    bindings = await rest.bindingGraph(workers);
  } catch (e) {
    gaps.push(`rest.workers: ${(e as Error).message}`);
  }
  for (const [label, fn] of [
    ["rest.kv", () => rest.listKv()],
    ["rest.r2", () => rest.listR2()],
    ["rest.d1", () => rest.listD1()],
  ] as const) {
    try {
      items.push(...(await fn()));
    } catch (e) {
      gaps.push(`${label}: ${(e as Error).message}`);
    }
  }
  return { items, bindings, gaps };
}

/** Seed a fresh per-resource map from inventory (incl. current D1 storage). */
function seedResources(inv: Inventory): Map<string, ResourceUsage> {
  const byKey = new Map<string, ResourceUsage>();
  for (const it of inv.items) {
    const r: ResourceUsage = { kind: it.kind, id: it.id, name: it.name, metrics: {} };
    if (it.kind === "d1" && it.storageBytes !== undefined) {
      r.metrics["d1.storageGbMonth"] = it.storageBytes / 1e9;
    }
    byKey.set(`${it.kind}:${it.id}`, r);
  }
  return byKey;
}

/**
 * Snapshot the `days` most recent days (today back), reusing one inventory
 * pass. Cloudflare retains roughly 30 days of analytics, so days<=30 backfills
 * the current month. Storage for past days uses the current size as an
 * approximation (Cloudflare exposes no historical D1 size).
 */
export async function collectRange(creds: Creds, days: number, now: Date): Promise<DaySnapshot[]> {
  const rest = new RestClient(creds.accountId, creds.token);
  const gql = new GraphqlClient(creds.accountId, creds.token);
  const inv = await fetchInventory(rest);
  const datasetCount = 5; // workers, kv, r2.ops, r2.storage, d1

  const snapshots: DaySnapshot[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const day = utcDay(d);

    const byKey = seedResources(inv);
    const usage = await gql.collect(dayWindow(day, now));
    for (const [key, { name, metrics }] of usage.metrics) {
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      let r = byKey.get(key);
      if (!r) {
        r = { kind: kind as ResourceUsage["kind"], id, name, metrics: {} };
        byKey.set(key, r);
      }
      for (const [metric, value] of Object.entries(metrics)) {
        r.metrics[metric as keyof typeof r.metrics] = value;
      }
    }

    const gaps = [...inv.gaps, ...usage.gaps];
    const status: DaySnapshot["status"] =
      usage.gaps.length >= datasetCount ? "error" : gaps.length ? "partial" : "ok";

    snapshots.push({
      day,
      resources: [...byKey.values()],
      bindings: inv.bindings,
      status,
      gaps,
      createdAt: now.toISOString(),
    });
  }
  return snapshots;
}

/**
 * Collect usage for one arbitrary window in a single pass (no per-day loop).
 * Used by the stateless public (BYO-key) mode: one inventory pass + one
 * GraphQL query per dataset, nothing stored.
 */
export async function collectWindow(
  creds: Creds,
  start: string,
  end: string,
): Promise<{ resources: ResourceUsage[]; bindings: BindingGraph; gaps: string[] }> {
  const rest = new RestClient(creds.accountId, creds.token);
  const gql = new GraphqlClient(creds.accountId, creds.token);
  const inv = await fetchInventory(rest);
  const byKey = seedResources(inv);
  const usage = await gql.collect({ start, end });
  for (const [key, { name, metrics }] of usage.metrics) {
    const [kind, ...rest] = key.split(":");
    const id = rest.join(":");
    let r = byKey.get(key);
    if (!r) {
      r = { kind: kind as ResourceUsage["kind"], id, name, metrics: {} };
      byKey.set(key, r);
    }
    for (const [metric, value] of Object.entries(metrics)) {
      r.metrics[metric as keyof typeof r.metrics] = value;
    }
  }
  return { resources: [...byKey.values()], bindings: inv.bindings, gaps: [...inv.gaps, ...usage.gaps] };
}

/** Collect a single day (used by the daily cron via collectRange of 1). */
export async function collectDay(creds: Creds, day: string, now: Date): Promise<DaySnapshot> {
  // Find how many days back `day` is so collectRange's window logic applies.
  const target = new Date(`${day}T00:00:00Z`);
  const today = new Date(`${utcDay(now)}T00:00:00Z`);
  const back = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  const range = await collectRange(creds, Math.max(1, back + 1), now);
  return range.find((s) => s.day === day) ?? range[range.length - 1]!;
}

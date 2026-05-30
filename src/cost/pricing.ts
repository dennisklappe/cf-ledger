/**
 * Cloudflare Workers Paid pricing, as a dated constant.
 *
 * SOURCE OF TRUTH: https://developers.cloudflare.com/workers/platform/pricing/
 * (and the per-product pricing pages for KV, R2, D1).
 *
 * These rates and free allowances are ACCOUNT-WIDE, not per-application.
 * The allocation logic in ./attribute.ts subtracts the free allowance at the
 * account level and then distributes the billable cost across apps in
 * proportion to their usage share, so per-app dollars sum to the real bill.
 *
 * Update `AS_OF` and the numbers below when Cloudflare changes pricing.
 */

export const AS_OF = "2026-05-30";

/** Flat monthly platform fee for the Workers Paid plan. */
export const PLATFORM_FEE_USD = 5.0;

/**
 * A metered metric: a per-unit price plus the account-wide monthly amount that
 * is included for free. `unit` is documentation only (used in the UI legend).
 */
export interface Rate {
  /** USD per `per` units. */
  price: number;
  /** Units bundled free per month, account-wide. */
  freeMonthly: number;
  /** Size of a pricing block, e.g. 1_000_000 for "$X per million". */
  per: number;
  /** Human label for the unit, e.g. "requests", "GB-month". */
  unit: string;
}

/** Every metric we know how to price. Keys are stable metric ids. */
export type MetricId =
  | "workers.requests"
  | "workers.cpuMs"
  | "kv.reads"
  | "kv.writes"
  | "kv.deletes"
  | "kv.lists"
  | "kv.storageGbMonth"
  | "r2.classA"
  | "r2.classB"
  | "r2.storageGbMonth"
  | "d1.rowsRead"
  | "d1.rowsWritten"
  | "d1.storageGbMonth";

export const PRICING: Record<MetricId, Rate> = {
  // Workers (Standard usage model).
  "workers.requests": { price: 0.3, freeMonthly: 10_000_000, per: 1_000_000, unit: "requests" },
  "workers.cpuMs": { price: 0.02, freeMonthly: 30_000_000, per: 1_000_000, unit: "CPU-ms" },

  // Workers KV.
  "kv.reads": { price: 0.5, freeMonthly: 10_000_000, per: 1_000_000, unit: "reads" },
  "kv.writes": { price: 5.0, freeMonthly: 1_000_000, per: 1_000_000, unit: "writes" },
  "kv.deletes": { price: 5.0, freeMonthly: 1_000_000, per: 1_000_000, unit: "deletes" },
  "kv.lists": { price: 5.0, freeMonthly: 1_000_000, per: 1_000_000, unit: "lists" },
  "kv.storageGbMonth": { price: 0.5, freeMonthly: 1, per: 1, unit: "GB-month" },

  // R2 (egress is free, so it is intentionally not metered here).
  "r2.classA": { price: 4.5, freeMonthly: 1_000_000, per: 1_000_000, unit: "Class A ops" },
  "r2.classB": { price: 0.36, freeMonthly: 10_000_000, per: 1_000_000, unit: "Class B ops" },
  "r2.storageGbMonth": { price: 0.015, freeMonthly: 10, per: 1, unit: "GB-month" },

  // D1.
  "d1.rowsRead": { price: 0.001, freeMonthly: 25_000_000_000, per: 1_000_000, unit: "rows read" },
  "d1.rowsWritten": { price: 1.0, freeMonthly: 50_000_000, per: 1_000_000, unit: "rows written" },
  "d1.storageGbMonth": { price: 0.75, freeMonthly: 5, per: 1, unit: "GB-month" },
};

/**
 * Cost of `units` of a metric assuming NO free allowance.
 * Used for per-app marginal cost before account-level free-tier allocation.
 */
export function rawCost(metric: MetricId, units: number): number {
  const rate = PRICING[metric];
  return (units / rate.per) * rate.price;
}

/**
 * Cost of `units` AFTER subtracting the account-wide free allowance.
 * Used for the account total. Never negative.
 */
export function billableCost(metric: MetricId, units: number): number {
  const rate = PRICING[metric];
  const billableUnits = Math.max(0, units - rate.freeMonthly);
  return (billableUnits / rate.per) * rate.price;
}

/** Billable (post-free-allowance) unit count for a metric. */
export function billableUnits(metric: MetricId, units: number): number {
  return Math.max(0, units - PRICING[metric].freeMonthly);
}

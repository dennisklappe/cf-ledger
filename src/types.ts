import type { MetricId } from "./cost/pricing";

/** Cloudflare resource kinds we attribute cost for in v1. */
export type ResourceKind = "worker" | "kv" | "r2" | "d1";

/**
 * One resource's measured usage for a period, as raw metric units.
 * Only the metrics relevant to the kind are populated.
 */
export interface ResourceUsage {
  kind: ResourceKind;
  /** Stable id: worker scriptName, KV namespace id, R2 bucket name, D1 db id. */
  id: string;
  /** Human-friendly name (often equal to id). */
  name: string;
  /** Raw usage per metric, e.g. { "kv.reads": 4200000 }. */
  metrics: Partial<Record<MetricId, number>>;
}

/**
 * The binding graph: which Workers reference which resources.
 * Built from each Worker's bindings via the REST API.
 * Key = `${kind}:${id}` of a non-worker resource, value = worker scriptNames.
 */
export type BindingGraph = Record<string, string[]>;

/** How a resource's cost is attributed. */
export type Attribution =
  | { type: "owned"; app: string } // bound to exactly one worker
  | { type: "shared"; apps: string[] } // bound to several workers
  | { type: "standalone" }; // bound to no worker (the leak suspects)

/** A single priced line: one resource, one metric. */
export interface CostLine {
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  metric: MetricId;
  units: number;
  /** Allocated dollars for this line (sums to the real bill across all lines). */
  costUsd: number;
  attribution: Attribution;
}

/** Rolled-up cost for one application (or the Shared / Standalone groups). */
export interface AppCost {
  /** App name (worker scriptName), or "__shared__" / "__standalone__". */
  app: string;
  group: "app" | "shared" | "standalone";
  totalUsd: number;
  lines: CostLine[];
}

/** The full computed breakdown for a period. */
export interface CostReport {
  /** "YYYY-MM" the report covers. */
  month: string;
  pricingAsOf: string;
  platformFeeUsd: number;
  /** Sum of all allocated line costs (excludes the flat platform fee). */
  usageUsd: number;
  /** usageUsd + platformFeeUsd. */
  totalUsd: number;
  apps: AppCost[];
  /** Metrics seen in usage that we had no price for (surfaced, never $0). */
  unpriced: string[];
}

/**
 * Turns raw per-resource usage into per-application dollars.
 *
 * The honest part: free allowances are account-wide, so we cannot apply them
 * per app. Instead, for each metric we:
 *   1. sum usage across every resource to get the account total,
 *   2. subtract the account-wide free allowance to get the BILLABLE cost,
 *   3. split that billable cost across resources in proportion to each
 *      resource's share of the metric's total usage.
 * Each resource's allocated cost is then assigned to an app via the binding
 * graph. The result: per-app dollars that SUM EXACTLY to the account bill.
 */

import {
  PRICING,
  PLATFORM_FEE_USD,
  AS_OF,
  billableCost,
  rawCost,
  type MetricId,
} from "./pricing";
import type {
  ResourceUsage,
  BindingGraph,
  Attribution,
  CostLine,
  AppCost,
  CostReport,
} from "../types";

export const SHARED = "__shared__";
export const STANDALONE = "__standalone__";

const isPriced = (m: string): m is MetricId => m in PRICING;

/** The prefix before the first hyphen, e.g. "treingeldterug-api" -> "treingeldterug". */
function prefixOf(worker: string): string {
  const i = worker.indexOf("-");
  return i === -1 ? worker : worker.slice(0, i);
}

/**
 * Map each Worker to its project label. A prefix shared by 2+ Workers collapses
 * into one project (e.g. all "treingeldterug-*" become "treingeldterug"); a
 * lone Worker keeps its full name. This is what lets a database shared across
 * the Workers of one project attribute to that project instead of "Shared".
 */
function buildProjectLabeler(workers: Iterable<string>): (w: string) => string {
  const countByPrefix = new Map<string, number>();
  const seen = new Set<string>();
  for (const w of workers) {
    if (seen.has(w)) continue;
    seen.add(w);
    const p = prefixOf(w);
    countByPrefix.set(p, (countByPrefix.get(p) ?? 0) + 1);
  }
  return (w: string) => {
    const p = prefixOf(w);
    return (countByPrefix.get(p) ?? 0) > 1 ? p : w;
  };
}

/** Resolve how one resource's cost is attributed, grouping Workers by project. */
function attributionFor(
  usage: ResourceUsage,
  bindings: BindingGraph,
  project: (w: string) => string,
): Attribution {
  if (usage.kind === "worker") {
    return { type: "owned", app: project(usage.id) };
  }
  const owners = bindings[`${usage.kind}:${usage.id}`] ?? [];
  const projects = [...new Set(owners.map(project))];
  if (projects.length === 1) return { type: "owned", app: projects[0]! };
  if (projects.length > 1) return { type: "shared", apps: [...owners].sort() };
  return { type: "standalone" };
}

/** Which group an attribution lands in. */
function groupKey(attr: Attribution): string {
  if (attr.type === "owned") return attr.app;
  if (attr.type === "shared") return SHARED;
  return STANDALONE;
}

export interface ReportOptions {
  /**
   * Apply the account-wide monthly free allowances (the real invoice view).
   * When false, every unit is priced at list (no free tier), so each app's
   * full consumption is visible. Only meaningful for a full calendar month;
   * date ranges always run list-price. Default true.
   */
  applyFreeAllowance?: boolean;
  /** Add the flat $5 Workers Paid platform fee. Default true. */
  includePlatformFee?: boolean;
}

/**
 * Build the full cost report for a period from raw usage + the binding graph.
 *
 * @param period    label for the window ("YYYY-MM", or "from to to")
 * @param resources raw usage per resource
 * @param bindings  worker->resource references (see BindingGraph)
 * @param opts      free-allowance and platform-fee toggles
 */
export function buildReport(
  period: string,
  resources: ResourceUsage[],
  bindings: BindingGraph,
  opts: ReportOptions = {},
): CostReport {
  const applyFree = opts.applyFreeAllowance ?? true;
  const includeFee = opts.includePlatformFee ?? true;

  // 0. Group Workers into projects by shared name prefix.
  const allWorkers: string[] = [];
  for (const r of resources) if (r.kind === "worker") allWorkers.push(r.id);
  for (const owners of Object.values(bindings)) allWorkers.push(...owners);
  const project = buildProjectLabeler(allWorkers);

  // 1. Account-wide total usage per metric.
  const totalByMetric = new Map<MetricId, number>();
  const unpriced = new Set<string>();
  for (const r of resources) {
    for (const [metric, units] of Object.entries(r.metrics)) {
      if (!units) continue;
      if (!isPriced(metric)) {
        unpriced.add(metric);
        continue;
      }
      totalByMetric.set(metric, (totalByMetric.get(metric) ?? 0) + units);
    }
  }

  // 2. Per-unit allocation rate. Billed mode subtracts the account-wide free
  //    allowance then spreads the remaining cost by usage share; list-price
  //    mode prices every unit at the raw rate (no free tier).
  const allocRate = new Map<MetricId, number>();
  for (const [metric, total] of totalByMetric) {
    const cost = applyFree ? billableCost(metric, total) : rawCost(metric, total);
    allocRate.set(metric, total > 0 ? cost / total : 0);
  }

  // 3. Allocate each resource's usage to dollars and group by app.
  const groups = new Map<string, CostLine[]>();
  for (const r of resources) {
    const attr = attributionFor(r, bindings, project);
    const key = groupKey(attr);
    let lines = groups.get(key);
    if (!lines) {
      lines = [];
      groups.set(key, lines);
    }
    for (const [metric, units] of Object.entries(r.metrics)) {
      if (!units || !isPriced(metric)) continue;
      lines.push({
        resourceKind: r.kind,
        resourceId: r.id,
        resourceName: r.name,
        metric,
        units,
        costUsd: units * (allocRate.get(metric) ?? 0),
        attribution: attr,
      });
    }
  }

  // 4. Roll up per app, sort the heaviest spenders first.
  const apps: AppCost[] = [];
  for (const [app, lines] of groups) {
    const totalUsd = lines.reduce((s, l) => s + l.costUsd, 0);
    const group: AppCost["group"] =
      app === SHARED ? "shared" : app === STANDALONE ? "standalone" : "app";
    apps.push({ app, group, totalUsd, lines });
  }
  apps.sort((a, b) => {
    // Real apps first (by cost desc), then shared, then standalone.
    const rank = (g: AppCost["group"]) => (g === "app" ? 0 : g === "shared" ? 1 : 2);
    return rank(a.group) - rank(b.group) || b.totalUsd - a.totalUsd;
  });

  const usageUsd = apps.reduce((s, a) => s + a.totalUsd, 0);
  const platformFeeUsd = includeFee ? PLATFORM_FEE_USD : 0;
  return {
    month: period,
    pricingAsOf: AS_OF,
    platformFeeUsd,
    usageUsd,
    totalUsd: usageUsd + platformFeeUsd,
    apps,
    unpriced: [...unpriced].sort(),
  };
}

/**
 * Read/write the D1 history store and roll daily snapshots up into the monthly
 * usage that the cost engine prices.
 *
 * Aggregation rule: storage metrics (`*.storageGbMonth`) are AVERAGED across the
 * days present (instantaneous GB -> GB-month); every other metric is SUMMED.
 */

import type { MetricId } from "../cost/pricing";
import type { BindingGraph, ResourceKind, ResourceUsage } from "../types";

const isStorage = (metric: string) => metric.endsWith("storageGbMonth");

export interface DaySnapshot {
  day: string; // YYYY-MM-DD
  resources: ResourceUsage[];
  bindings: BindingGraph;
  status: "ok" | "partial" | "error";
  gaps: string[];
  createdAt: string; // ISO8601
}

export interface MonthUsage {
  resources: ResourceUsage[];
  bindings: BindingGraph;
  lastUpdated: string | null;
  gaps: string[];
}

export class SnapshotStore {
  constructor(private readonly db: D1Database) {}

  /** Persist one day's snapshot, replacing any prior run for the same day. */
  async write(snap: DaySnapshot): Promise<void> {
    const stmts: D1PreparedStatement[] = [];
    stmts.push(this.db.prepare("DELETE FROM snapshot WHERE day = ?").bind(snap.day));
    stmts.push(this.db.prepare("DELETE FROM binding WHERE day = ?").bind(snap.day));

    const ins = this.db.prepare(
      "INSERT INTO snapshot (day, kind, resource_id, name, metric, units) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const r of snap.resources) {
      for (const [metric, units] of Object.entries(r.metrics)) {
        if (units === undefined) continue;
        stmts.push(ins.bind(snap.day, r.kind, r.id, r.name, metric, units));
      }
    }

    const insB = this.db.prepare("INSERT INTO binding (day, resource_key, worker) VALUES (?, ?, ?)");
    for (const [key, workers] of Object.entries(snap.bindings)) {
      for (const w of workers) stmts.push(insB.bind(snap.day, key, w));
    }

    stmts.push(
      this.db
        .prepare(
          "INSERT OR REPLACE INTO snapshot_meta (day, created_at, status, gaps) VALUES (?, ?, ?, ?)",
        )
        .bind(snap.day, snap.createdAt, snap.status, JSON.stringify(snap.gaps)),
    );

    await this.db.batch(stmts);
  }

  /** Aggregate a month ("YYYY-MM") of daily snapshots into priced-ready usage. */
  async readMonth(month: string): Promise<MonthUsage> {
    return this.readRange(`${month}-01`, `${month}-31`);
  }

  /**
   * Aggregate an inclusive day range ("YYYY-MM-DD" to "YYYY-MM-DD") into
   * priced-ready usage. Storage metrics are averaged over the days present;
   * counters are summed. A single day uses from === to.
   */
  async readRange(from: string, to: string): Promise<MonthUsage> {
    const rows = await this.db
      .prepare(
        `SELECT kind, resource_id, name, metric,
                SUM(units) AS sum_units, AVG(units) AS avg_units
         FROM snapshot WHERE day BETWEEN ? AND ?
         GROUP BY kind, resource_id, name, metric`,
      )
      .bind(from, to)
      .all<AggRow>();

    const byResource = new Map<string, ResourceUsage>();
    for (const row of rows.results ?? []) {
      const key = `${row.kind}:${row.resource_id}`;
      let res = byResource.get(key);
      if (!res) {
        res = { kind: row.kind as ResourceKind, id: row.resource_id, name: row.name, metrics: {} };
        byResource.set(key, res);
      }
      const value = isStorage(row.metric) ? row.avg_units : row.sum_units;
      res.metrics[row.metric as MetricId] = value;
    }

    return {
      resources: [...byResource.values()],
      bindings: await this.bindingsForRange(from, to),
      lastUpdated: await this.lastUpdated(from, to),
      gaps: await this.gapsForRange(from, to),
    };
  }

  /** Months that have any data, newest first, e.g. ["2026-05", "2026-04"]. */
  async listMonths(): Promise<string[]> {
    const rows = await this.db
      .prepare("SELECT DISTINCT substr(day, 1, 7) AS m FROM snapshot ORDER BY m DESC")
      .all<{ m: string }>();
    return (rows.results ?? []).map((r) => r.m);
  }

  /** Use the most recent day's binding graph within the range. */
  private async bindingsForRange(from: string, to: string): Promise<BindingGraph> {
    const rows = await this.db
      .prepare(
        `SELECT resource_key, worker FROM binding
         WHERE day = (SELECT MAX(day) FROM binding WHERE day BETWEEN ? AND ?)`,
      )
      .bind(from, to)
      .all<{ resource_key: string; worker: string }>();
    const graph: BindingGraph = {};
    for (const r of rows.results ?? []) (graph[r.resource_key] ??= []).push(r.worker);
    return graph;
  }

  private async lastUpdated(from: string, to: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT MAX(created_at) AS t FROM snapshot_meta WHERE day BETWEEN ? AND ?")
      .bind(from, to)
      .first<{ t: string | null }>();
    return row?.t ?? null;
  }

  private async gapsForRange(from: string, to: string): Promise<string[]> {
    const row = await this.db
      .prepare(
        `SELECT gaps FROM snapshot_meta
         WHERE day BETWEEN ? AND ? ORDER BY day DESC LIMIT 1`,
      )
      .bind(from, to)
      .first<{ gaps: string }>();
    try {
      return row ? (JSON.parse(row.gaps) as string[]) : [];
    } catch {
      return [];
    }
  }
}

interface AggRow {
  kind: string;
  resource_id: string;
  name: string;
  metric: string;
  sum_units: number;
  avg_units: number;
}

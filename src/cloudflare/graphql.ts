/**
 * Cloudflare GraphQL Analytics client: usage numbers per resource for a time
 * window. Each dataset is queried independently and fails soft: if one dataset
 * errors (schema drift, permissions, no data) we record a `gap` string and keep
 * the rest, rather than fabricating zeros or losing the whole snapshot.
 *
 * Returns instantaneous storage in GB for storage metrics (so that averaging
 * daily snapshots over a month yields GB-month) and summed counts for ops.
 */

import type { MetricId } from "../cost/pricing";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

/** Per-resource metric accumulation, keyed by `${kind}:${id}`. */
export type MetricMap = Map<string, { name: string; metrics: Partial<Record<MetricId, number>> }>;

export interface UsageResult {
  metrics: MetricMap;
  gaps: string[];
}

interface Window {
  /** ISO8601, inclusive lower bound. */
  start: string;
  /** ISO8601, exclusive-ish upper bound. */
  end: string;
}

export class GraphqlClient {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
  ) {}

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new Error(body.errors.map((e) => e.message).join("; "));
    }
    if (!res.ok || !body.data) throw new Error(`GraphQL HTTP ${res.status}`);
    return body.data;
  }

  /** Merge a metric value into the map. */
  private static add(map: MetricMap, key: string, name: string, metric: MetricId, value: number) {
    const entry = map.get(key) ?? { name, metrics: {} };
    entry.metrics[metric] = (entry.metrics[metric] ?? 0) + value;
    map.set(key, entry);
  }

  async collect(win: Window): Promise<UsageResult> {
    const metrics: MetricMap = new Map();
    const gaps: string[] = [];
    const run = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        gaps.push(`${label}: ${(e as Error).message}`);
      }
    };

    await run("workers", () => this.workers(win, metrics));
    await run("kv", () => this.kv(win, metrics));
    await run("r2.ops", () => this.r2ops(win, metrics));
    await run("r2.storage", () => this.r2storage(win, metrics));
    await run("d1", () => this.d1(win, metrics));

    return { metrics, gaps };
  }

  private async workers(win: Window, out: MetricMap): Promise<void> {
    const data = await this.query<AccountData<"workersInvocationsAdaptive", WorkerRow>>(
      `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
        workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_lt:$e}){
          dimensions{scriptName} sum{requests} quantiles{cpuTimeP50}
        }}}}`,
      { a: this.accountId, s: win.start, e: win.end },
    );
    for (const row of rows(data, "workersInvocationsAdaptive")) {
      const name = row.dimensions.scriptName;
      const key = `worker:${name}`;
      GraphqlClient.add(out, key, name, "workers.requests", row.sum.requests);
      // CPU billing is per-request CPU time. The adaptive dataset exposes
      // quantiles, not a sum, so total CPU-ms is ESTIMATED as
      // requests * medianCpuTime. cpuTimeP50 is in microseconds.
      const cpuMs = (row.sum.requests * row.quantiles.cpuTimeP50) / 1000;
      GraphqlClient.add(out, key, name, "workers.cpuMs", cpuMs);
    }
  }

  private async kv(win: Window, out: MetricMap): Promise<void> {
    const data = await this.query<AccountData<"kvOperationsAdaptiveGroups", KvRow>>(
      `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
        kvOperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_lt:$e}){
          dimensions{namespaceId actionType} sum{requests}
        }}}}`,
      { a: this.accountId, s: win.start, e: win.end },
    );
    const map: Record<string, MetricId> = {
      read: "kv.reads",
      write: "kv.writes",
      delete: "kv.deletes",
      list: "kv.lists",
    };
    for (const row of rows(data, "kvOperationsAdaptiveGroups")) {
      const metric = map[row.dimensions.actionType];
      if (!metric) continue;
      const id = row.dimensions.namespaceId;
      GraphqlClient.add(out, `kv:${id}`, id, metric, row.sum.requests);
    }
  }

  private async r2ops(win: Window, out: MetricMap): Promise<void> {
    const data = await this.query<AccountData<"r2OperationsAdaptiveGroups", R2OpRow>>(
      `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
        r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_lt:$e}){
          dimensions{bucketName actionType} sum{requests}
        }}}}`,
      { a: this.accountId, s: win.start, e: win.end },
    );
    for (const row of rows(data, "r2OperationsAdaptiveGroups")) {
      const bucket = row.dimensions.bucketName;
      const metric = classifyR2(row.dimensions.actionType);
      if (!metric) continue;
      GraphqlClient.add(out, `r2:${bucket}`, bucket, metric, row.sum.requests);
    }
  }

  private async r2storage(win: Window, out: MetricMap): Promise<void> {
    const data = await this.query<AccountData<"r2StorageAdaptiveGroups", R2StorageRow>>(
      `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
        r2StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_lt:$e}){
          dimensions{bucketName} max{payloadSize metadataSize}
        }}}}`,
      { a: this.accountId, s: win.start, e: win.end },
    );
    for (const row of rows(data, "r2StorageAdaptiveGroups")) {
      const bucket = row.dimensions.bucketName;
      const bytes = (row.max.payloadSize ?? 0) + (row.max.metadataSize ?? 0);
      GraphqlClient.add(out, `r2:${bucket}`, bucket, "r2.storageGbMonth", bytes / 1e9);
    }
  }

  private async d1(win: Window, out: MetricMap): Promise<void> {
    const data = await this.query<AccountData<"d1AnalyticsAdaptiveGroups", D1Row>>(
      `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
        d1AnalyticsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_lt:$e}){
          dimensions{databaseId} sum{rowsRead rowsWritten}
        }}}}`,
      { a: this.accountId, s: win.start, e: win.end },
    );
    for (const row of rows(data, "d1AnalyticsAdaptiveGroups")) {
      const id = row.dimensions.databaseId;
      GraphqlClient.add(out, `d1:${id}`, id, "d1.rowsRead", row.sum.rowsRead);
      GraphqlClient.add(out, `d1:${id}`, id, "d1.rowsWritten", row.sum.rowsWritten);
    }
  }
}

/** Map an R2 action type to a billing class. Unknown actions are ignored. */
function classifyR2(action: string): MetricId | null {
  // Class A: mutating / listing operations. Class B: reads/metadata.
  const A = /Put|Post|Copy|List|Multipart|Delete.*Multipart|Create/i;
  const B = /Get|Head/i;
  if (A.test(action)) return "r2.classA";
  if (B.test(action)) return "r2.classB";
  return null;
}

// --- GraphQL response shapes -------------------------------------------------

type AccountData<K extends string, Row> = {
  viewer: { accounts: Array<{ [P in K]: Row[] }> };
};

function rows<K extends string, Row>(data: AccountData<K, Row>, key: K): Row[] {
  return data.viewer.accounts[0]?.[key] ?? [];
}

interface WorkerRow {
  dimensions: { scriptName: string };
  sum: { requests: number };
  quantiles: { cpuTimeP50: number };
}
interface KvRow {
  dimensions: { namespaceId: string; actionType: string };
  sum: { requests: number };
}
interface R2OpRow {
  dimensions: { bucketName: string; actionType: string };
  sum: { requests: number };
}
interface R2StorageRow {
  dimensions: { bucketName: string };
  max: { payloadSize?: number; metadataSize?: number };
}
interface D1Row {
  dimensions: { databaseId: string };
  sum: { rowsRead: number; rowsWritten: number };
}

/**
 * Cloudflare REST API client: inventory + the binding graph.
 *
 * GraphQL gives us usage numbers; REST tells us what exists and which Worker
 * is bound to which resource. We use REST for D1 storage size too (GraphQL
 * does not expose it reliably).
 */

import type { BindingGraph, ResourceKind } from "../types";

const API = "https://api.cloudflare.com/client/v4";

export interface WorkerScript {
  name: string;
}

/** A resource discovered via inventory, with optional storage size in bytes. */
export interface InventoryItem {
  kind: ResourceKind;
  id: string;
  name: string;
  storageBytes?: number;
}

interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

export class RestClient {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const body = (await res.json()) as CfEnvelope<T>;
    if (!res.ok || !body.success) {
      const msg = body.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || res.statusText;
      throw new Error(`Cloudflare REST ${path} failed: ${msg}`);
    }
    return body.result;
  }

  private acct(path: string): string {
    return `/accounts/${this.accountId}${path}`;
  }

  async listWorkers(): Promise<WorkerScript[]> {
    const scripts = await this.get<{ id: string }[]>(this.acct("/workers/scripts"));
    return scripts.map((s) => ({ name: s.id }));
  }

  /** Bindings declared by a single Worker, normalized to resource refs. */
  async workerBindings(scriptName: string): Promise<{ kind: ResourceKind; id: string }[]> {
    const settings = await this.get<{ bindings?: RawBinding[] }>(
      this.acct(`/workers/scripts/${encodeURIComponent(scriptName)}/settings`),
    );
    const refs: { kind: ResourceKind; id: string }[] = [];
    for (const b of settings.bindings ?? []) {
      const ref = normalizeBinding(b);
      if (ref) refs.push(ref);
    }
    return refs;
  }

  async listKv(): Promise<InventoryItem[]> {
    const ns = await this.get<{ id: string; title: string }[]>(this.acct("/storage/kv/namespaces"));
    return ns.map((n) => ({ kind: "kv" as const, id: n.id, name: n.title }));
  }

  async listR2(): Promise<InventoryItem[]> {
    const { buckets } = await this.get<{ buckets: { name: string }[] }>(this.acct("/r2/buckets"));
    return buckets.map((b) => ({ kind: "r2" as const, id: b.name, name: b.name }));
  }

  async listD1(): Promise<InventoryItem[]> {
    const dbs = await this.get<{ uuid: string; name: string; file_size?: number }[]>(
      this.acct("/d1/database"),
    );
    return dbs.map((d) => ({
      kind: "d1" as const,
      id: d.uuid,
      name: d.name,
      storageBytes: d.file_size,
    }));
  }

  /**
   * Build the binding graph: for every non-worker resource, which Worker
   * scriptNames reference it. Workers with no bindings still count as apps;
   * they simply own no resources here.
   */
  async bindingGraph(workers: WorkerScript[]): Promise<BindingGraph> {
    const graph: BindingGraph = {};
    for (const w of workers) {
      let refs: { kind: ResourceKind; id: string }[] = [];
      try {
        refs = await this.workerBindings(w.name);
      } catch {
        // A single unreadable Worker should not sink the whole graph.
        continue;
      }
      for (const ref of refs) {
        const key = `${ref.kind}:${ref.id}`;
        (graph[key] ??= []).push(w.name);
      }
    }
    // De-dupe (a Worker can bind the same resource twice under two names).
    for (const key of Object.keys(graph)) {
      graph[key] = [...new Set(graph[key])];
    }
    return graph;
  }
}

interface RawBinding {
  type: string;
  namespace_id?: string;
  bucket_name?: string;
  id?: string;
}

/** Map a raw Worker binding to a resource ref we track, or null if untracked. */
function normalizeBinding(b: RawBinding): { kind: ResourceKind; id: string } | null {
  switch (b.type) {
    case "kv_namespace":
      return b.namespace_id ? { kind: "kv", id: b.namespace_id } : null;
    case "r2_bucket":
      return b.bucket_name ? { kind: "r2", id: b.bucket_name } : null;
    case "d1":
      return b.id ? { kind: "d1", id: b.id } : null;
    default:
      return null; // durable objects, queues, services, etc. -> v1 roadmap
  }
}

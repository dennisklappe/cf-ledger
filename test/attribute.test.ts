import { describe, it, expect } from "vitest";
import { buildReport, SHARED, STANDALONE } from "../src/cost/attribute";
import type { ResourceUsage, BindingGraph } from "../src/types";

const resources: ResourceUsage[] = [
  { kind: "worker", id: "api", name: "api", metrics: { "workers.requests": 20_000_000, "workers.cpuMs": 40_000_000 } },
  { kind: "worker", id: "web", name: "web", metrics: { "workers.requests": 5_000_000, "workers.cpuMs": 10_000_000 } },
  { kind: "kv", id: "ns1", name: "sessions", metrics: { "kv.reads": 12_000_000 } },
  { kind: "r2", id: "bucket1", name: "uploads", metrics: { "r2.classA": 2_000_000 } },
  { kind: "d1", id: "db1", name: "analytics", metrics: { "d1.rowsWritten": 60_000_000 } },
];

// ns1 owned by api; bucket1 shared by api+web; db1 bound to nobody (standalone).
const bindings: BindingGraph = {
  "kv:ns1": ["api"],
  "r2:bucket1": ["api", "web"],
};

describe("buildReport", () => {
  const report = buildReport("2026-05", resources, bindings);

  it("per-app dollars sum to the real account bill", () => {
    // Account billable cost, computed independently:
    //   requests 25M -> 15M billable -> $4.50
    //   cpuMs    50M -> 20M billable -> $0.40
    //   kv.reads 12M ->  2M billable -> $1.00
    //   r2.classA 2M ->  1M billable -> $4.50
    //   d1.rowsWritten 60M -> 10M billable -> $10.00
    const expectedUsage = 4.5 + 0.4 + 1.0 + 4.5 + 10.0;
    expect(report.usageUsd).toBeCloseTo(expectedUsage, 6);
    const sumApps = report.apps.reduce((s, a) => s + a.totalUsd, 0);
    expect(sumApps).toBeCloseTo(report.usageUsd, 6);
    expect(report.totalUsd).toBeCloseTo(expectedUsage + 5, 6); // + platform fee
  });

  it("attributes owned, shared, and standalone resources correctly", () => {
    const byApp = Object.fromEntries(report.apps.map((a) => [a.app, a]));
    expect(byApp["api"]!.totalUsd).toBeCloseTo(3.6 + 0.32 + 1.0, 6); // compute + owned KV
    expect(byApp["web"]!.totalUsd).toBeCloseTo(0.9 + 0.08, 6);
    expect(byApp[SHARED]!.totalUsd).toBeCloseTo(4.5, 6);
    expect(byApp[STANDALONE]!.totalUsd).toBeCloseTo(10.0, 6);

    expect(byApp[SHARED]!.group).toBe("shared");
    expect(byApp[STANDALONE]!.group).toBe("standalone");
  });

  it("ranks real apps first by cost, then shared, then standalone", () => {
    expect(report.apps.map((a) => a.app)).toEqual(["api", "web", SHARED, STANDALONE]);
  });

  it("folds resources shared within one project into that project, not Shared", () => {
    const res: ResourceUsage[] = [
      { kind: "worker", id: "tg-api", name: "tg-api", metrics: { "workers.requests": 1_000_000 } },
      { kind: "worker", id: "tg-pipeline", name: "tg-pipeline", metrics: { "workers.requests": 1_000_000 } },
      { kind: "d1", id: "db", name: "tg-db", metrics: { "d1.rowsWritten": 60_000_000 } },
    ];
    const bind: BindingGraph = { "d1:db": ["tg-api", "tg-pipeline"] };
    const r = buildReport("2026-05", res, bind, { applyFreeAllowance: false, includePlatformFee: false });
    const byApp = Object.fromEntries(r.apps.map((a) => [a.app, a]));
    expect(byApp["tg"]).toBeTruthy(); // tg-api + tg-pipeline collapse to "tg"
    expect(byApp[SHARED]).toBeFalsy(); // the shared D1 is no longer "shared"
    expect(byApp["tg"]!.lines.some((l) => l.metric === "d1.rowsWritten")).toBe(true);
    expect(byApp["tg"]!.totalUsd).toBeCloseTo(60.0 + 0.3 + 0.3, 6); // d1 $60 + 2x 1M requests
  });

  it("surfaces unpriced metrics instead of silently zeroing them", () => {
    const withMystery = buildReport("2026-05", [
      { kind: "worker", id: "x", name: "x", metrics: { "workers.requests": 1, "queues.messages": 99 } as never },
    ], {});
    expect(withMystery.unpriced).toContain("queues.messages");
  });
});

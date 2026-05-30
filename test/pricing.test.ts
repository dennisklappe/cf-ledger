import { describe, it, expect } from "vitest";
import { rawCost, billableCost, billableUnits } from "../src/cost/pricing";

describe("pricing", () => {
  it("rawCost ignores the free allowance", () => {
    expect(rawCost("workers.requests", 1_000_000)).toBeCloseTo(0.3, 9);
    expect(rawCost("kv.writes", 2_000_000)).toBeCloseTo(10.0, 9);
  });

  it("billableCost subtracts the account-wide free allowance", () => {
    expect(billableCost("workers.requests", 10_000_000)).toBe(0); // entirely free
    expect(billableCost("workers.requests", 11_000_000)).toBeCloseTo(0.3, 9);
    expect(billableCost("kv.writes", 2_000_000)).toBeCloseTo(5.0, 9); // 1M billable
    expect(billableCost("d1.rowsWritten", 60_000_000)).toBeCloseTo(10.0, 9); // 10M billable
  });

  it("billableUnits never goes negative", () => {
    expect(billableUnits("r2.classA", 500_000)).toBe(0);
    expect(billableUnits("r2.classA", 2_000_000)).toBe(1_000_000);
  });
});

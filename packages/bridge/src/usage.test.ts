import { describe, expect, it } from "vitest";
import { fetchAllUsage, fetchPiUsage } from "./usage.js";

describe("usage (pi-only)", () => {
  it("reports a single pi provider without rate-limit windows", async () => {
    const result = await fetchPiUsage();
    expect(result.provider).toBe("pi");
    expect(result.fiveHour).toBeNull();
    expect(result.sevenDay).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it("fetchAllUsage returns only the pi provider (no codex/claude disk reads)", async () => {
    const all = await fetchAllUsage();
    expect(all).toHaveLength(1);
    expect(all[0].provider).toBe("pi");
    expect(all[0].fiveHour).toBeNull();
    expect(all[0].sevenDay).toBeNull();
  });
});

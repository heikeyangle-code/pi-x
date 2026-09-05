/**
 * Usage — pi-only.
 *
 * The original CC Pocket reported provider rate-limit windows (codex
 * five-hour/seven-day limits scanned from ~/.codex/sessions). With pi as the
 * only engine there are no such windows: pi tracks per-session token/cost
 * statistics via the `get_session_stats` RPC (tokens.input/output/cacheRead/
 * cacheWrite + cost). The wire shape (UsageInfo.provider/fiveHour/sevenDay)
 * is kept so the app UI keeps rendering, but the provider is always "pi" and
 * the windows are null.
 */

// ── Types ──

export interface UsageWindow {
  utilization: number;  // percentage 0-100
  resetsAt: string;     // ISO 8601
}

export interface UsageInfo {
  provider: "claude" | "codex" | "pi";
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  error?: string;
}

/**
 * Pi usage — no codex-style rate-limit windows exist. The engine exposes
 * session-level token/cost stats (get_session_stats); those are rendered by
 * the engine settings UI, not by the provider window model here.
 */
export async function fetchPiUsage(): Promise<UsageInfo> {
  return {
    provider: "pi",
    fiveHour: null,
    sevenDay: null,
  };
}

export async function fetchAllUsage(): Promise<UsageInfo[]> {
  return [await fetchPiUsage()];
}

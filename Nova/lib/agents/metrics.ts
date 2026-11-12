export interface ModelCall {
  agent: string;
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  fallback: boolean;
  at: string;
}

// Global store so all route module instances share one registry in the process.
const globalStore = globalThis as unknown as { __novaMetrics?: ModelCall[] };
if (!globalStore.__novaMetrics) globalStore.__novaMetrics = [];
const calls: ModelCall[] = globalStore.__novaMetrics;
const MAX_CALLS = 500;

// Rough USD per 1M tokens (input/output). Free providers = 0.
const COST_PER_M: Record<string, [number, number]> = {
  "openai:gpt-6.1-sol": [2.0, 10.0],
  "openai:gpt-6-sol": [2.0, 10.0],
  "anthropic:claude-opus-5-5": [4.0, 20.0],
  "anthropic:claude-sonnet-5-5": [2.0, 10.0],
  "anthropic:claude-haiku-5-5": [0.1, 0.5],
};

export function recordCall(c: ModelCall): void {
  calls.push(c);
  if (calls.length > MAX_CALLS) calls.shift();
}

export function recentCalls(n = 50): ModelCall[] {
  return calls.slice(-n);
}

export interface ModelStats {
  key: string;
  calls: number;
  ok: number;
  failed: number;
  successRate: number;
  avgMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  fallbacks: number;
  estimatedCostUsd: number;
}

export function summary(): { stats: ModelStats[]; totals: { calls: number; ok: number; failed: number; estimatedCostUsd: number } } {
  const groups = new Map<string, ModelStats>();

  for (const c of calls) {
    const key = `${c.agent} :: ${c.provider}/${c.model}`;
    let s = groups.get(key);
    if (!s) {
      s = {
        key,
        calls: 0,
        ok: 0,
        failed: 0,
        successRate: 0,
        avgMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        fallbacks: 0,
        estimatedCostUsd: 0,
      };
      groups.set(key, s);
    }
    s.calls++;
    if (c.ok) s.ok++;
    else s.failed++;
    s.avgMs += c.ms;
    s.totalInputTokens += c.inputTokens ?? 0;
    s.totalOutputTokens += c.outputTokens ?? 0;
    if (c.fallback) s.fallbacks++;
    const cost = COST_PER_M[`${c.provider}:${c.model}`];
    if (cost) {
      s.estimatedCostUsd +=
        ((c.inputTokens ?? 0) / 1e6) * cost[0] + ((c.outputTokens ?? 0) / 1e6) * cost[1];
    }
  }

  const stats = [...groups.values()].map((s) => ({
    ...s,
    successRate: s.calls ? Math.round((s.ok / s.calls) * 100) : 0,
    avgMs: s.calls ? Math.round(s.avgMs / s.calls) : 0,
    estimatedCostUsd: Math.round(s.estimatedCostUsd * 10000) / 10000,
  }));

  return {
    stats: stats.sort((a, b) => b.calls - a.calls),
    totals: {
      calls: calls.length,
      ok: calls.filter((c) => c.ok).length,
      failed: calls.filter((c) => !c.ok).length,
      estimatedCostUsd:
        Math.round(stats.reduce((acc, s) => acc + s.estimatedCostUsd, 0) * 10000) / 10000,
    },
  };
}

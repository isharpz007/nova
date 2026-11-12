"use client";

import { useEffect, useState } from "react";

interface ModelStats {
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

interface Metrics {
  stats: ModelStats[];
  totals: { calls: number; ok: number; failed: number; estimatedCostUsd: number };
  assignments: Record<string, { primary: string; fallback: string }>;
  recentCalls: Array<{
    agent: string;
    provider: string;
    model: string;
    ok: boolean;
    ms: number;
    at: string;
  }>;
}

const AGENT_ORDER = ["lead", "fast", "interviewer", "designer", "developer"];

export default function ModelsPage() {
  const [data, setData] = useState<Metrics | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch("/api/agents/metrics");
        if (r.ok && alive) setData(await r.json());
      } catch {
        // best-effort
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const assignments = data?.assignments ?? {};
  const statsByAgent = (agent: string) =>
    (data?.stats ?? []).filter((s) => s.key.startsWith(`${agent} ::`));

  return (
    <div className="max-w-3xl mx-auto w-full space-y-4">
      <h1 className="text-lg font-semibold">AI Models</h1>
      <p className="text-sm text-slate-500 dark:text-neutral-400">
        Which model powers each agent, plus live performance. Nova doesn&apos;t train models — it
        routes to hosted providers (OpenAI, Gemini, Anthropic, Groq, local Ollama) configured in
        your environment.
      </p>

      <div className="space-y-3">
        {AGENT_ORDER.map((agent) => {
          const a = assignments[agent];
          const rows = statsByAgent(agent);
          return (
            <section
              key={agent}
              className="rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#262626] p-4"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h2 className="text-sm font-semibold capitalize">{agent} Agent</h2>
                {a ? (
                  <div className="flex gap-2 text-[11px]">
                    <span className="rounded-full bg-teal-500/15 text-teal-600 dark:text-teal-300 px-2.5 py-1 font-mono">
                      {a.primary}
                    </span>
                    <span className="rounded-full bg-slate-100 dark:bg-white/10 text-slate-500 dark:text-neutral-400 px-2.5 py-1 font-mono">
                      backup: {a.fallback}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-slate-400">loading…</span>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="mt-2 text-xs text-slate-400 dark:text-neutral-500">
                  No calls recorded yet this session.
                </p>
              ) : (
                <table className="mt-3 w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-400 dark:text-neutral-500">
                      <th className="pb-1 font-medium">Model used</th>
                      <th className="pb-1 font-medium text-right">Calls</th>
                      <th className="pb-1 font-medium text-right">Success</th>
                      <th className="pb-1 font-medium text-right">Avg ms</th>
                      <th className="pb-1 font-medium text-right">Tokens</th>
                      <th className="pb-1 font-medium text-right">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr
                        key={s.key}
                        className="border-t border-slate-100 dark:border-white/5 text-slate-600 dark:text-neutral-300"
                      >
                        <td className="py-1.5 font-mono">
                          {s.key.split("::")[1]?.trim()}
                          {s.fallbacks > 0 && (
                            <span className="ml-1 text-yellow-500">({s.fallbacks} fb)</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right">{s.calls}</td>
                        <td
                          className={`py-1.5 text-right ${
                            s.successRate >= 80
                              ? "text-green-600 dark:text-green-400"
                              : "text-red-600 dark:text-red-400"
                          }`}
                        >
                          {s.successRate}%
                        </td>
                        <td className="py-1.5 text-right">{s.avgMs}</td>
                        <td className="py-1.5 text-right">
                          {s.totalInputTokens + s.totalOutputTokens}
                        </td>
                        <td className="py-1.5 text-right">
                          ${s.estimatedCostUsd.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>

      {data && (
        <p className="text-xs text-slate-400 dark:text-neutral-500">
          Session totals: {data.totals.calls} calls · {data.totals.ok} ok ·{" "}
          {data.totals.failed} failed · est. ${data.totals.estimatedCostUsd.toFixed(4)} ·
          refreshes every 5s
        </p>
      )}
    </div>
  );
}

import { NextResponse } from "next/server";
import { probeProvider, type ProviderId } from "@/lib/agents/llm";

/**
 * GET /api/health/models — development only.
 * Probes each credentialed provider (plus Ollama) with a tiny call and reports
 * ok/error/ms. Never returns or logs key material.
 */

const PROVIDER_LIST: ProviderId[] = ["openai", "gemini", "groq", "anthropic", "custom", "ollama"];

const ENV_VARS = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "ANTHROPIC_API_KEY",
  "CUSTOM_LLM_URL",
  "CUSTOM_LLM_API_KEY",
  "CUSTOM_LLM_MODEL",
  "OLLAMA_URL",
  "OLLAMA_MODEL",
  "TAVILY_API_KEY",
  "DEVIN_API_KEY",
  "DEVIN_DELEGATE",
] as const;

const PROBE_TIMEOUT_MS = 15_000;

/** Mask anything that could be key material before it leaves the process. */
function mask(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, "$1…")
    .replace(/(Bearer\s+)\S+/gi, "$1***")
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, "$1***")
    .replace(/(x-goog-api-key|x-api-key|authorization)\s*[:=]\s*\S+/gi, "$1=***")
    .slice(0, 150);
}

export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const env: Record<string, boolean> = {};
  for (const name of ENV_VARS) env[name] = Boolean(process.env[name]);

  const active = PROVIDER_LIST.filter((p) => {
    if (p === "openai") return env.OPENAI_API_KEY;
    if (p === "gemini") return env.GEMINI_API_KEY;
    if (p === "groq") return env.GROQ_API_KEY;
    if (p === "anthropic") return env.ANTHROPIC_API_KEY;
    if (p === "custom") return env.CUSTOM_LLM_URL;
    return true; // ollama — always probed
  });

  const providers = await Promise.all(
    active.map(async (provider) => {
      const probe = probeProvider(provider, [{ role: "user", content: "Reply with: ok" }], 10);
      const r = await Promise.race([
        probe,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("probe timed out")), PROBE_TIMEOUT_MS)
        ),
      ]).catch((e): { ok: false; model: string; ms: number; error: string } => ({
        ok: false,
        model: "?",
        ms: PROBE_TIMEOUT_MS,
        error: e instanceof Error ? e.message : "failed",
      }));
      return {
        provider,
        model: r.model,
        ok: r.ok,
        ...(r.error ? { error: mask(r.error) } : {}),
        ms: r.ms,
      };
    })
  );

  return NextResponse.json({ providers, env });
}

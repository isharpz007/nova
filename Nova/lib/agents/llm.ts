import type { AgentId } from "./types";
import { recordCall } from "./metrics";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Central AI router — agents never call providers directly.
// Provider chain per agent: primary (env-configurable) -> backups -> local Ollama.
// ---------------------------------------------------------------------------

export type ProviderId = "openai" | "gemini" | "groq" | "anthropic" | "ollama" | "custom";

export interface ProviderResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  /** True when the provider stopped because it hit the output token limit. */
  truncated?: boolean;
}

type ProviderCall = (messages: ChatMessage[], model: string) => Promise<ProviderResult>;

const API_TIMEOUT = 90_000;
const MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 8192);

// ---------- provider implementations ----------

async function openai(messages: ChatMessage[], model: string): Promise<ProviderResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_completion_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message ?? "failed";
    const tag = res.status === 429 ? "rate-limited" : `(${res.status})`;
    throw new Error(`OpenAI ${tag}: ${String(detail).slice(0, 200)}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty OpenAI response");
  return {
    text,
    inputTokens: data?.usage?.prompt_tokens,
    outputTokens: data?.usage?.completion_tokens,
    truncated: data?.choices?.[0]?.finish_reason === "length",
  };
}

async function gemini(messages: ChatMessage[], model: string): Promise<ProviderResult> {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY!,
      },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        generationConfig: { maxOutputTokens: MAX_TOKENS },
      }),
      signal: AbortSignal.timeout(API_TIMEOUT),
    }
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Gemini (${res.status}): ${String(data?.error?.message ?? "failed").slice(0, 200)}`);
  }
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Empty Gemini response");
  return {
    text,
    inputTokens: data?.usageMetadata?.promptTokenCount,
    outputTokens: data?.usageMetadata?.candidatesTokenCount,
    truncated: data?.candidates?.[0]?.finishReason === "MAX_TOKENS",
  };
}

async function groq(messages: ChatMessage[], model: string): Promise<ProviderResult> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message ?? "failed";
    const tag = res.status === 429 ? "rate-limited" : `(${res.status})`;
    throw new Error(`Groq ${tag}: ${String(detail).slice(0, 200)}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty Groq response");
  return {
    text,
    inputTokens: data?.usage?.prompt_tokens,
    outputTokens: data?.usage?.completion_tokens,
    truncated: data?.choices?.[0]?.finish_reason === "length",
  };
}

async function anthropic(messages: ChatMessage[], model: string): Promise<ProviderResult> {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: messages.filter((m) => m.role !== "system"),
    }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Anthropic (${res.status}): ${String(data?.error?.message ?? "failed").slice(0, 200)}`);
  }
  const text = data?.content?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty Anthropic response");
  return {
    text,
    inputTokens: data?.usage?.input_tokens,
    outputTokens: data?.usage?.output_tokens,
    truncated: data?.stop_reason === "max_tokens",
  };
}

async function ollama(messages: ChatMessage[], model: string): Promise<ProviderResult> {
  const base = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, keep_alive: "30m", messages }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Ollama (${res.status}): ${String(data?.error ?? "failed").slice(0, 200)}`);
  }
  const text = data?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty Ollama response");
  return {
    text,
    inputTokens: data?.prompt_eval_count,
    outputTokens: data?.eval_count,
    truncated: data?.done_reason === "length",
  };
}

/**
 * Your own model. Works with any OpenAI-compatible server
 * (llama.cpp llama-server, vLLM, LocalAI, a custom training/inference server).
 * Configure with CUSTOM_LLM_URL, CUSTOM_LLM_MODEL and (optionally) CUSTOM_LLM_API_KEY.
 */
async function customLlm(messages: ChatMessage[], model: string): Promise<ProviderResult> {
  const base = (process.env.CUSTOM_LLM_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.CUSTOM_LLM_API_KEY
        ? { authorization: `Bearer ${process.env.CUSTOM_LLM_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message ?? data?.error ?? "failed";
    throw new Error(`Custom LLM (${res.status}): ${String(detail).slice(0, 200)}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty custom LLM response");
  return {
    text,
    inputTokens: data?.usage?.prompt_tokens,
    outputTokens: data?.usage?.completion_tokens,
    truncated: data?.choices?.[0]?.finish_reason === "length",
  };
}

// ---------- registry ----------

const PROVIDERS: Record<ProviderId, { available: () => boolean; call: ProviderCall }> = {
  openai: { available: () => Boolean(process.env.OPENAI_API_KEY), call: openai },
  gemini: { available: () => Boolean(process.env.GEMINI_API_KEY), call: gemini },
  groq: { available: () => Boolean(process.env.GROQ_API_KEY), call: groq },
  anthropic: { available: () => Boolean(process.env.ANTHROPIC_API_KEY), call: anthropic },
  custom: { available: () => Boolean(process.env.CUSTOM_LLM_URL), call: customLlm },
  ollama: { available: () => true, call: ollama },
};

const DEFAULT_MODEL: Record<ProviderId, string> = {
  openai: "gpt-6.1-sol",
  gemini: "gemini-3.5-flash",
  groq: "openai/gpt-oss-120b",
  anthropic: "claude-haiku-5-5",
  custom: process.env.CUSTOM_LLM_MODEL ?? "my-model",
  ollama: process.env.OLLAMA_MODEL ?? "llama3.2:3b",
};

/**
 * Per-agent model config: primary + configured fallback, each "provider:model".
 * Overridable via MODEL_<AGENT>_PRIMARY / MODEL_<AGENT>_FALLBACK env vars.
 */
const DEFAULT_CONFIG: Record<AgentId, { primary: string; fallback: string }> = {
  lead: { primary: "openai:gpt-6.1-sol", fallback: "anthropic:claude-opus-5-5" },
  fast: { primary: "gemini:gemini-3.5-flash-lite", fallback: "anthropic:claude-haiku-5-5" },
  interviewer: { primary: "anthropic:claude-sonnet-5-5", fallback: "openai:gpt-6.1-sol" },
  designer: { primary: "anthropic:claude-opus-5-5", fallback: "gemini:gemini-3.5-flash" },
  developer: { primary: "openai:gpt-6-sol", fallback: "anthropic:claude-sonnet-5-5" },
  author: { primary: "anthropic:claude-opus-5-5", fallback: "anthropic:claude-sonnet-5-5" },
};

const BACKUP_ORDER: ProviderId[] = ["openai", "gemini", "anthropic", "groq", "custom", "ollama"];

interface ModelSpec {
  provider: ProviderId;
  model: string;
}

function parseSpec(spec: string): ModelSpec | null {
  const [p, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (p in PROVIDERS && model) return { provider: p as ProviderId, model };
  return null;
}

/** Resolved primary/fallback for each agent (env overrides applied). */
export function agentAssignments(): Record<AgentId, { primary: string; fallback: string }> {
  const out = {} as Record<AgentId, { primary: string; fallback: string }>;
  for (const agent of Object.keys(DEFAULT_CONFIG) as AgentId[]) {
    const upper = agent.toUpperCase();
    const cfg = DEFAULT_CONFIG[agent];
    out[agent] = {
      primary: (process.env[`MODEL_${upper}_PRIMARY`] ?? cfg.primary).replace(/^"|"$/g, ""),
      fallback: (process.env[`MODEL_${upper}_FALLBACK`] ?? cfg.fallback).replace(/^"|"$/g, ""),
    };
  }
  return out;
}

/** Ordered chain of provider:model pairs an agent may use. */
function chainFor(agent: AgentId): ModelSpec[] {
  const upper = agent.toUpperCase();
  const cfg = DEFAULT_CONFIG[agent];
  const chain: ModelSpec[] = [];

  const primary =
    parseSpec(process.env[`MODEL_${upper}_PRIMARY`] ?? "") ?? parseSpec(cfg.primary);
  const fallback =
    parseSpec(process.env[`MODEL_${upper}_FALLBACK`] ?? "") ?? parseSpec(cfg.fallback);
  if (primary) chain.push(primary);
  if (fallback) chain.push(fallback);

  // Remaining providers as extra backups (Ollama is always last via BACKUP_ORDER).
  for (const p of BACKUP_ORDER) {
    if (!chain.some((s) => s.provider === p)) {
      chain.push({ provider: p, model: DEFAULT_MODEL[p] });
    }
  }
  return chain;
}

/** Transient failures worth one same-model retry before falling back. */
function isTransient(msg: string): boolean {
  if (/insufficient[_ ]quota|out_of_quota|billing|credit balance|exceeded your current quota/i.test(msg)) return false;
  return /429|rate[- ]?limit|timeout|timed out|aborted|\(5\d\d\)/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAY_MS = 2500;

async function runChain(
  label: string,
  chain: ModelSpec[],
  messages: ChatMessage[]
): Promise<ProviderResult> {
  const errors: string[] = [];
  let index = 0;
  for (const spec of chain) {
    const provider = PROVIDERS[spec.provider];
    if (!provider.available()) {
      errors.push(`${spec.provider}: skipped (no credentials)`);
      continue;
    }
    // Up to 2 attempts per spec: immediate try + one retry for transient errors.
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      try {
        const r = await provider.call(messages, spec.model);
        const ms = Date.now() - started;
        recordCall({
          agent: label,
          provider: spec.provider,
          model: spec.model,
          ok: true,
          ms,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          fallback: index > 0,
          at: new Date().toISOString(),
        });
        console.info(
          `[router] ${label} -> ${spec.provider}/${spec.model} ${ms}ms` +
            (r.inputTokens !== undefined ? ` tokens=${r.inputTokens}+${r.outputTokens ?? 0}` : "") +
            (r.truncated ? " TRUNCATED" : "")
        );
        return r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "failed";
        const ms = Date.now() - started;
        recordCall({
          agent: label,
          provider: spec.provider,
          model: spec.model,
          ok: false,
          ms,
          fallback: index > 0,
          at: new Date().toISOString(),
        });
        errors.push(`${spec.provider}/${spec.model}: ${msg}`);
        console.warn(`[router] ${label} ${spec.provider}/${spec.model} failed (${ms}ms): ${msg}`);
        if (attempt === 0 && isTransient(msg)) {
          await sleep(RETRY_DELAY_MS);
          continue; // retry same model once
        }
        break;
      }
    }
    index++;
  }
  throw new Error(`All providers failed for ${label} — ${errors.join(" | ")}`);
}

/** Route a call to the model assigned to a specific agent, with fallback. */
export async function callAgent(agent: AgentId, messages: ChatMessage[]): Promise<string> {
  return (await runChain(agent, chainFor(agent), messages)).text;
}

/** Same as callAgent but returns the full result — callers can check `truncated`. */
export function callAgentDetailed(agent: AgentId, messages: ChatMessage[]): Promise<ProviderResult> {
  return runChain(agent, chainFor(agent), messages);
}

/** Generic call with no agent assignment — tries the full provider order. */
export async function callModel(messages: ChatMessage[]): Promise<string> {
  return (
    await runChain(
      "default",
      BACKUP_ORDER.map((p) => ({ provider: p, model: DEFAULT_MODEL[p] })),
      messages
    )
  ).text;
}

/** Call an agent's model and parse a JSON object from the reply. Retries once. */
export async function callJson<T>(agent: AgentId, messages: ChatMessage[]): Promise<T> {
  let msgs = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await callAgent(agent, msgs);
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        // Fall through to retry.
      }
    }
    msgs = [...msgs, { role: "user", content: "Your reply was not valid JSON. Reply with a single JSON object only." }];
  }
  throw new Error("Agent returned invalid JSON twice");
}
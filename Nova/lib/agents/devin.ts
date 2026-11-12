import { callAgent } from "./llm";
import { gatherSources, buildBrief, detectStack } from "./outlook_llm";
import type { Source } from "./outlook_llm";
import { generateFiles } from "./codegen";

/**
 * Devin (Cognition) integration — a software engineering service, not an LLM.
 * Enabled only when DEVIN_API_KEY and DEVIN_DELEGATE=true are configured.
 * Creates a session, polls until finished, returns the structured output.
 *
 * runDevinOrRescue() wraps it: if Devin is off, out of quota, or fails, Outlook
 * researches the task online and a working model completes it from the sources.
 */
const BASE = "https://api.devin.ai/v1";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function devinEnabled(): boolean {
  return Boolean(process.env.DEVIN_API_KEY) && process.env.DEVIN_DELEGATE === "true";
}

export async function runDevinTask(prompt: string): Promise<string> {
  const key = process.env.DEVIN_API_KEY;
  if (!key) throw new Error("Devin not configured (DEVIN_API_KEY missing)");

  const create = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(30_000),
  });
  const session = await create.json().catch(() => null);
  if (!create.ok) {
    throw new Error(`Devin create (${create.status}): ${String(session?.detail ?? "failed").slice(0, 200)}`);
  }
  const id = session?.session_id ?? session?.id;
  if (!id) throw new Error("Devin returned no session id");

  const maxWait = Number(process.env.DEVIN_MAX_WAIT_MS ?? 600_000);
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const res = await fetch(`${BASE}/sessions/${id}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    const sj = await res.json().catch(() => null);
    const status = String(sj?.status_enum ?? sj?.status ?? "");
    if (status === "finished" || status === "stopped") {
      const out = sj?.structured_output;
      if (out && typeof out === "object") return JSON.stringify(out, null, 2);
      return String(sj?.summary ?? "Devin session finished without structured output.");
    }
    if (status === "blocked" || status === "expired") {
      throw new Error(`Devin session ended with status ${status}`);
    }
  }
  throw new Error("Devin session timed out");
}

// ---------------------------------------------------------------------------
// Rescue path
// ---------------------------------------------------------------------------

export interface DevinOutcome {
  text: string; // final output to hand to the lead agent
  rescued: boolean; // true = Devin didn't do this; Outlook + a model did
  reason?: string; // why Devin was skipped or failed
  sources: Source[]; // web sources used (empty when Devin did the work)
}

// Billing/auth errors won't fix themselves, so stop calling Devin for a while.
const DEVIN_COOLDOWN_MS = Number(process.env.DEVIN_COOLDOWN_MS ?? 30 * 60_000);
let devinDownUntil = 0;

function isBillingOrAuth(msg: string): boolean {
  return /\((401|402|403)\)|out_of_quota|billing|quota|unauthorized/i.test(msg);
}

async function rescue(prompt: string, reason: string, goal?: string): Promise<DevinOutcome> {
  const stack = detectStack(`${goal ?? ""}\n${prompt}`);
  const query = [goal ?? prompt, ...stack].join(" ").slice(0, 380);
  const { sources } = await gatherSources(query, { agent: "fast", maxResults: 8, maxPages: 5 });
  const brief = buildBrief(sources);

  const stackRule = stack.length
    ? ` Required stack: ${stack.join(", ")} — the output MUST use this stack; if the ` +
      `research suggests a different framework, ignore it and stay on this stack.`
    : "";
  const system =
    "You are the fallback for a software-engineering service that is unavailable. " +
    "Complete the task using the web research provided plus your own solid knowledge. " +
    "Give concrete code, file paths and steps. You cannot run code, commands, servers or " +
    "requests, and you cannot access the repository or the user's systems — never claim you " +
    "did; state clearly what the user must apply or verify and give the exact commands or " +
    "steps. Cite research as [n]; use a source only if it is clearly about the task and ignore " +
    "irrelevant sources. Do not invent APIs or options that neither the research nor your " +
    "knowledge supports." +
    stackRule;
  const user =
    `${goal ? `Original goal: ${goal}\n\n` : ""}` +
    `Task:\n${prompt}\n\nWeb research:\n${brief || "(no web research available)"}`;

  // Code deliverables: one model call per file (with truncation retry) instead
  // of a single long response that can get cut off.
  const viaFiles = await generateFiles(user, system).catch(() => null);
  const answer =
    viaFiles ??
    (await callAgent("lead", [
      { role: "system", content: system },
      { role: "user", content: user },
    ]));
  const list = sources.length
    ? "\n\nSources:\n" + sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")
    : "";

  return {
    text: `[Devin unavailable — completed via web research and fallback model]\n\n${answer}${list}`,
    rescued: true,
    reason,
    sources,
  };
}

/**
 * Drop-in replacement for runDevinTask in the orchestrator.
 * Tries Devin first; on any failure (or when Devin is off/cooling down),
 * Outlook researches the task and a working model finishes it.
 */
export async function runDevinOrRescue(prompt: string, goal?: string): Promise<DevinOutcome> {
  if (!devinEnabled()) return rescue(prompt, "Devin disabled", goal);
  if (Date.now() < devinDownUntil) return rescue(prompt, "Devin cooling down after a billing/auth error", goal);

  try {
    const text = await runDevinTask(prompt);
    return { text, rescued: false, sources: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed";
    if (isBillingOrAuth(msg)) devinDownUntil = Date.now() + DEVIN_COOLDOWN_MS;
    console.warn(`[devin] failed, rescuing via Outlook: ${msg}`);
    try {
      return await rescue(prompt, msg, goal);
    } catch (rescueErr) {
      const rmsg = rescueErr instanceof Error ? rescueErr.message : "failed";
      throw new Error(`Devin failed (${msg}) and rescue failed (${rmsg})`);
    }
  }
}
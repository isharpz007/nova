import { callJson } from "./llm";
import type { ChatMessage } from "./llm";
import type { AgentId } from "./types";

// ---------------------------------------------------------------------------
// outlook_llm — research pipeline that sits in front of the LLM router.
//   search -> scrape pages -> clean -> dedupe -> filter for relevance -> write tasks
// Every step degrades gracefully: if search, scraping or the LLM fails, you still
// get whatever was gathered, and nothing here throws on the happy-path callers use.
// ---------------------------------------------------------------------------

export interface Source {
  title: string;
  url: string;
  snippet: string; // short text from the search engine
  text: string; // cleaned page text (empty if the page couldn't be scraped)
  score: number; // 0-10 relevance
  facts: string[]; // key points the filter pulled out (LLM only)
}

export interface Task {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  sources: number[]; // 1-based indexes into the returned sources
}

export interface OutlookOptions {
  maxResults?: number; // search results to consider (default 8)
  maxPages?: number; // pages to scrape (default 5)
  minScore?: number; // drop sources below this relevance (default 4)
  agent?: AgentId; // agent used for filtering and writing (default "fast")
  useLlmFilter?: boolean; // false = keyword scoring only, no LLM call (default true)
}

export interface OutlookResult {
  sources: Source[];
  tasks: Task[];
  brief: string; // ready-to-inject research text for any other agent
  warnings: string[];
}

const PAGE_TIMEOUT = 12_000;
const MAX_HTML_CHARS = 600_000;
const MAX_TEXT_CHARS = 5_000;
const UA = "Mozilla/5.0 (compatible; OutlookLLM/1.0)";

// ---------- search ----------

interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchTavily(query: string, max: number): Promise<RawResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({ query: query.slice(0, 380), max_results: max }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Tavily (${res.status})`);
  return (data?.results ?? []).map((r: { title?: string; url?: string; content?: string }) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.content ?? "").slice(0, 500),
  }));
}

/** Keyless fallback: scrapes DuckDuckGo's HTML results page. Fragile by nature. */
async function searchDuckDuckGo(query: string, max: number): Promise<RawResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo (${res.status})`);
  const html = await res.text();
  const out: RawResult[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    let url = decodeEntities(m[1]);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      title: stripTags(m[2]),
      url,
      snippet: stripTags(m[3] ?? "").slice(0, 500),
    });
  }
  return out;
}

async function search(query: string, max: number, warnings: string[]): Promise<RawResult[]> {
  if (process.env.TAVILY_API_KEY) {
    try {
      const r = await searchTavily(query, max);
      if (r.length) return r;
    } catch (e) {
      warnings.push(`Tavily failed: ${e instanceof Error ? e.message : "error"}`);
    }
  }
  try {
    return await searchDuckDuckGo(query, max);
  } catch (e) {
    warnings.push(`DuckDuckGo failed: ${e instanceof Error ? e.message : "error"}`);
    return [];
  }
}

// ---------- scraping & cleaning ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Don't let search results point the scraper at internal addresses. */
function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    if (h === "::1" || h.startsWith("[")) return false;
    return true;
  } catch {
    return false;
  }
}

function htmlToText(html: string): string {
  let h = html.slice(0, MAX_HTML_CHARS);
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  h = h.replace(/<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ");
  // Prefer the main content block when the page has one.
  const main =
    h.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
    h.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    h;
  // Keep paragraph structure, then flatten.
  const text = main
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return decodeEntities(text.replace(/<[^>]*>/g, " "))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 40) // drop menus, buttons, one-word junk
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);
}

async function scrape(url: string): Promise<string> {
  if (!isSafeUrl(url)) return "";
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT),
    });
    if (!res.ok) return "";
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) return "";
    return htmlToText(await res.text());
  } catch {
    return "";
  }
}

// ---------- filtering ----------

const STOP = new Set(
  "the a an and or of to in on for with is are be this that it as at by from how what why do does can i my you your".split(" ")
);

function keywords(q: string): string[] {
  return Array.from(
    new Set(
      q
        .toLowerCase()
        .split(/[^a-z0-9#+.]+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
    )
  );
}

/** Cheap, offline relevance score (0-10). Used on its own or as the LLM fallback. */
function keywordScore(query: string, s: { title: string; snippet: string; text: string }): number {
  const kws = keywords(query);
  if (!kws.length) return 5;
  const hay = `${s.title} ${s.title} ${s.snippet} ${s.text}`.toLowerCase();
  const hits = kws.filter((k) => hay.includes(k)).length;
  const base = (hits / kws.length) * 8;
  const bonus = s.text.length > 800 ? 2 : s.text.length > 0 ? 1 : 0;
  return Math.min(10, Math.round(base + bonus));
}

function dedupe(list: RawResult[]): RawResult[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: RawResult[] = [];
  for (const r of list) {
    let key = r.url;
    try {
      const u = new URL(r.url);
      key = u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
    } catch {
      continue;
    }
    const t = r.title.toLowerCase().trim();
    if (seenUrl.has(key) || (t && seenTitle.has(t))) continue;
    seenUrl.add(key);
    if (t) seenTitle.add(t);
    out.push(r);
  }
  return out;
}

async function llmFilter(
  query: string,
  sources: Source[],
  agent: AgentId,
  warnings: string[]
): Promise<void> {
  const digest = sources
    .map((s, i) => `#${i + 1} ${s.title}\n${s.url}\n${(s.text || s.snippet).slice(0, 1500)}`)
    .join("\n\n---\n\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You filter web research. For each numbered source, rate relevance to the goal from 0-10 " +
        "(0 = off-topic, spam, or marketing fluff) and extract up to 3 concrete, factual points useful for the goal. " +
        'Reply with a single JSON object only: {"items":[{"index":1,"score":8,"facts":["..."]}]}',
    },
    { role: "user", content: `Goal: ${query}\n\nSources:\n\n${digest}` },
  ];
  try {
    const r = await callJson<{ items?: { index: number; score: number; facts?: string[] }[] }>(agent, messages);
    for (const it of r.items ?? []) {
      const s = sources[it.index - 1];
      if (!s) continue;
      s.score = Math.max(0, Math.min(10, Number(it.score) || 0));
      s.facts = (it.facts ?? []).filter((f) => typeof f === "string").slice(0, 3);
    }
  } catch (e) {
    warnings.push(`LLM filter unavailable, used keyword scoring: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
  }
}

// ---------- task writing ----------

export function buildBrief(sources: Source[]): string {
  if (!sources.length) return "";
  return sources
    .map((s, i) => {
      const body = s.facts.length ? s.facts.map((f) => `- ${f}`).join("\n") : (s.text || s.snippet).slice(0, 600);
      return `[${i + 1}] ${s.title}\n${s.url}\n${body}`;
    })
    .join("\n\n");
}

async function writeTasks(
  goal: string,
  brief: string,
  agent: AgentId,
  warnings: string[]
): Promise<Task[]> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You turn a goal plus web research into a clear, ordered task list for a developer. " +
        "Each task must be specific and actionable. Use only what the research supports; do not invent APIs or steps. " +
        'Reply with a single JSON object only: {"tasks":[{"title":"","description":"","priority":"high|medium|low","sources":[1]}]}',
    },
    { role: "user", content: `Goal: ${goal}\n\nResearch:\n\n${brief || "(no web research available)"}` },
  ];
  try {
    const r = await callJson<{ tasks?: Task[] }>(agent, messages);
    return (r.tasks ?? [])
      .filter((t) => t && typeof t.title === "string")
      .map((t) => ({
        title: t.title,
        description: String(t.description ?? ""),
        priority: (["high", "medium", "low"] as const).includes(t.priority) ? t.priority : "medium",
        sources: Array.isArray(t.sources) ? t.sources.filter((n) => Number.isInteger(n)) : [],
      }));
  } catch (e) {
    warnings.push(`Task writing failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
    return [];
  }
}

// ---------- query building ----------

const QUERY_FILLER =
  /\b(do it|do not|don't|please|report|show me|write the code|run a|quick test|test the|the results?|the pipeline|tell me|give me|make sure|for example|and so on|must be|should be|the user|your|you|this|that|these|those|send|requests?|to)\b/gi;

/**
 * Never pass a raw goal/instruction to a search engine — meta requests like
 * "run a quick test of the pipeline" poison results. Extract the key nouns
 * plus detected stack terms into a short query (<= 12 words).
 */
export function buildQuery(text: string, stack: string[] = []): string {
  const cleaned = text.replace(QUERY_FILLER, " ");
  const words = cleaned
    .toLowerCase()
    .split(/[^a-z0-9#+.]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const terms = [...new Set([...stack.map((s) => s.toLowerCase()), ...words])];
  return terms.slice(0, 12).join(" ");
}

// ---------- tech-stack detection ----------

const STACK_TERMS = [
  "flutter", "dart", "supabase", "firebase", "react", "next.js", "nextjs", "vue",
  "angular", "svelte", "node", "express", "fastapi", "django", "flask", "python",
  "typescript", "javascript", "postgres", "mysql", "mongodb", "tailwind", "kotlin",
  "swift", "rust", "laravel", "rails", "c#", ".net", "c++", "golang", "php", "java",
];

/**
 * Names the tech/frameworks mentioned in text so research and rescue prompts
 * can stay on-stack instead of drifting to whatever the sources used.
 */
export function detectStack(text: string): string[] {
  const found: string[] = [];
  for (const term of STACK_TERMS) {
    const re = new RegExp(`(^|\\W)${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`, "i");
    if (re.test(text)) found.push(term === "nextjs" ? "next.js" : term);
  }
  return [...new Set(found)].slice(0, 6);
}

// ---------- public API ----------

/** Search, scrape and filter the web for a query. No task writing. */
export async function gatherSources(query: string, opts: OutlookOptions = {}) {
  const { maxResults = 8, maxPages = 5, minScore = 4, agent = "fast", useLlmFilter = true } = opts;
  const warnings: string[] = [];

  const q = buildQuery(query, detectStack(query));
  if (!q) {
    warnings.push("No usable search terms in the request — research skipped");
    return { sources: [], warnings };
  }

  const raw = dedupe(await search(q, maxResults, warnings));

  // Scrape the top pages in parallel; the rest keep their search snippet only.
  const sources: Source[] = await Promise.all(
    raw.map(async (r, i): Promise<Source> => {
      const text = i < maxPages ? await scrape(r.url) : "";
      return { title: r.title, url: r.url, snippet: r.snippet, text, score: 0, facts: [] };
    })
  );

  for (const s of sources) s.score = keywordScore(query, s);
  if (useLlmFilter && sources.length) await llmFilter(query, sources, agent, warnings);

  const kept = sources
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score);

  if (!kept.length && sources.length) {
    warnings.push("All sources scored below the relevance threshold — research not used");
  }
  return { sources: kept, warnings };
}

/** Full pipeline: research the goal, filter it, and write tasks from it. */
export async function researchToTasks(goal: string, opts: OutlookOptions = {}): Promise<OutlookResult> {
  const { agent = "fast" } = opts;
  const { sources, warnings } = await gatherSources(goal, opts);
  const brief = buildBrief(sources);
  const tasks = await writeTasks(goal, brief, agent, warnings);
  return { sources, tasks, brief, warnings };
}

/** Append research to the system message so any agent can use it. */
export function withResearch(messages: ChatMessage[], brief: string): ChatMessage[] {
  if (!brief) return messages;
  const block =
    "\n\nWeb research (cite [n]). Use a source only if it is clearly about the task; " +
    "ignore irrelevant sources.\n" + brief;
  return messages.some((m) => m.role === "system")
    ? messages.map((m) => (m.role === "system" ? { ...m, content: m.content + block } : m))
    : [{ role: "system", content: block.trim() }, ...messages];
}

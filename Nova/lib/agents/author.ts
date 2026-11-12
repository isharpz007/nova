import { callAgentDetailed, type ChatMessage } from "./llm";
import { extractArtifacts } from "../artifacts";
import type { Source } from "./outlook_llm";

// ---------------------------------------------------------------------------
// Author Agent — the ONLY writer of user-facing text. It studies the finished
// subtask work and composes the reply. Code is never retyped: files are
// extracted first, the author emits {{file:PATH}} placeholders, and the exact
// original code is spliced back in afterwards.
// ---------------------------------------------------------------------------

export interface AuthorSubtask {
  id: string;
  agent: string;
  instruction: string;
  status: string;
  output?: string;
  error?: string;
}

export interface AuthorInput {
  goal: string;
  /** Prior conversation text, if any. */
  history?: string;
  /** The lead's plan (ids + instructions), for context. */
  plan?: { id: string; agent: string; instruction: string; dependsOn?: string[] }[];
  /** Every finished subtask with its final output and status. */
  subtasks: AuthorSubtask[];
  /** Numbered research sources — cited in the reply as [n]. */
  sources?: Source[];
  warnings?: string[];
  /** The lead's review notes. */
  reviewNotes?: string[];
}

const AUTHOR_SYSTEM =
  "You write the final reply that the user will read. You are given the user's request and the finished work from other agents. Study it, then write the best possible answer.\n" +
  "Style: plain, simple English. Short sentences. Friendly and direct. No filler openings like 'Sure!' or 'Great question'. Start with the direct answer or the result in one or two sentences, then give the details the user needs, in the order they will use them. Use numbered steps for instructions. Use headings only if the reply is long. Match length to the question: a simple question gets a short answer.\n" +
  "Accuracy: use only the finished work and the sources provided. Never invent facts, files, data, buckets, logs, links or earlier conversations. If two outputs disagree, use the more reliable one and do not mention the conflict unless it matters. If something is missing or incomplete, say so plainly and say what the user can do next. Never ask the user for passwords, keys or credentials; use clearly labeled placeholders such as YOUR_SUPABASE_URL.\n" +
  "Honesty: you cannot run code or access the user's systems, and neither could the agents. Never say anything was run, tested or verified unless the work shows it was. For code, say once, briefly, that it has not been tested.\n" +
  "Hide the machinery: never mention agents, subtasks, the lead, Devin, rescue, fallback, models, retries or internal IDs. If part of the work failed, describe it in user terms ('I could not finish the password reset screen') and say what is missing.\n" +
  "Sources: cite [n] only where a source directly supports a statement, and end with a short Sources list of the ones you used. Ignore sources that are not clearly about the task.\n" +
  "Code: do not retype code. Where a file belongs in the answer, write the placeholder {{file:PATH}} on its own line, and the system will insert the exact code. Add one short sentence about what the file does before each placeholder.\n" +
  "Finish with at most one short line on what to do next, if there is a clear next step.";

interface ExtractedFile {
  code: string;
  lang: string;
  description: string;
  /** Subtask id the file came from. */
  from: string;
}

/** First meaningful comment/doc line, else a language+size descriptor. */
function describeFile(path: string, code: string, lang: string): string {
  for (const line of code.split("\n").slice(0, 12)) {
    const t = line.trim();
    const m =
      t.match(/^\/\/\s*(.+)$/) ??
      t.match(/^\/\*\*?\s*(.+?)\s*\*?\/?$/) ??
      t.match(/^#\s*(.+)$/) ??
      t.match(/^<!--\s*(.+?)\s*-->$/) ??
      t.match(/^\/\/\/\s*(.+)$/);
    if (m && m[1].length > 8) return `${path} — ${m[1].slice(0, 120)}`;
    if (t && !/^(\*|\/\*|<!--|#|\/\/)/.test(t)) break;
  }
  const lines = code.split("\n").length;
  return `${path} — ${lang || "text"} file, ${lines} lines`;
}

interface ExtractedFiles {
  /** path -> file (all developer-produced files across subtasks) */
  files: Map<string, ExtractedFile>;
  /** subtask id -> ordered file paths extracted from that output */
  bySubtask: Map<string, string[]>;
}

/** Pull complete files out of DEVELOPER outputs into { path -> file }. */
function extractFiles(subtasks: AuthorSubtask[]): ExtractedFiles {
  const files = new Map<string, ExtractedFile>();
  const bySubtask = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const s of subtasks) {
    if (s.agent !== "developer" || !s.output) continue;
    for (const a of extractArtifacts(s.output)) {
      let path = a.path ?? "file";
      if (seen.has(path)) {
        let i = 2;
        while (seen.has(`${path} (${i})`)) i++;
        path = `${path} (${i})`;
      }
      seen.add(path);
      files.set(path, {
        code: a.content.replace(/\s+$/, ""),
        lang: a.language,
        description: describeFile(path, a.content, a.language),
        from: s.id,
      });
      const list = bySubtask.get(s.id) ?? [];
      list.push(path);
      bySubtask.set(s.id, list);
    }
  }
  return { files, bySubtask };
}

const FENCE = /```\s*\w*\s*\n[\s\S]*?```/g;

/** Strip code blocks from an output for the author's view — files live in the map. */
function withoutCode(text: string, paths: string[]): string {
  if (!paths.length) return text;
  let i = 0;
  const stripped = text.replace(FENCE, () => `[code moved to file: ${paths[i++] ?? "unknown"}]`);
  return stripped.slice(0, 4000);
}

/** Splice {{file:PATH}} placeholders back to real code; append missing files. */
function injectFiles(text: string, files: Map<string, ExtractedFile>): string {
  const used = new Set<string>();
  let out = text.replace(/\{\{file:([^}]+)\}\}/g, (_m, raw) => {
    const path = String(raw).trim();
    const f = files.get(path);
    if (!f) return ""; // unknown placeholder — drop it
    used.add(path);
    return `\`\`\`${f.lang || ""}\n${f.code}\n\`\`\``;
  });

  const missing = [...files.entries()].filter(([p]) => !used.has(p));
  if (missing.length) {
    out += "\n\n### Files\n";
    for (const [path, f] of missing) {
      out += `\n#### ${path}\n\n\`\`\`${f.lang || ""}\n${f.code}\n\`\`\`\n`;
    }
  }
  return out.trim();
}

/** No-AI fallback: the goal, each finished output in order, gaps stated plainly. */
export function fallbackResponse(input: AuthorInput): string {
  return injectFiles(deterministicReply(input), extractFiles(input.subtasks).files);
}

function deterministicReply(input: AuthorInput): string {
  const parts: string[] = [`Request: ${input.goal.trim()}`, ""];
  const done = input.subtasks.filter((s) => s.output?.trim());
  const gaps = input.subtasks.filter(
    (s) => s.status === "failed" || s.status === "failed_blocked" || (!s.output?.trim() && s.status !== "pending")
  );
  // Strip internal status markers from raw outputs before they reach the user.
  const scrub = (t: string) =>
    t.replace(/\[(Devin|rescue|rescued|agent|subtask|fallback)[^\]\n]*\]/gi, "").trim();
  for (const s of done) parts.push(scrub(s.output!), "");
  if (gaps.length) {
    parts.push("Not finished:");
    for (const s of gaps) parts.push(`- ${s.instruction} — could not be completed.`);
    parts.push("");
  }
  return parts.join("\n").trim() || "I wasn't able to produce a reply. Please try again.";
}

/** Build the author's view of the work: text only, code replaced by file index. */
function authorView(input: AuthorInput, extracted: ExtractedFiles, short: boolean): string {
  const lines: string[] = [];
  if (input.history?.trim()) lines.push(`Conversation context:\n${input.history.trim()}`, "");
  lines.push(`User's request: ${input.goal}`);

  if (input.plan?.length) {
    lines.push("", "Planned work:");
    for (const p of input.plan) lines.push(`- ${p.instruction}`);
  }

  const fileList = [...extracted.files.values()].map((f) => `- ${f.description}`);
  if (fileList.length) lines.push("", "Files produced (use {{file:PATH}} where each belongs):", ...fileList);

  for (const s of input.subtasks) {
    lines.push("", `--- Work item: ${s.instruction} [${s.status}] ---`);
    if (s.output?.trim()) lines.push(withoutCode(s.output, extracted.bySubtask.get(s.id) ?? []));
    else if (s.error) lines.push(`(failed — ${s.error.slice(0, 200)})`);
    else lines.push("(no output)");
  }

  if (input.reviewNotes?.length) lines.push("", "Review notes:", ...input.reviewNotes.map((n) => `- ${n}`));
  if (input.sources?.length) {
    lines.push("", "Sources (cite as [n] only where directly relevant):");
    input.sources.forEach((s, i) => lines.push(`[${i + 1}] ${s.title || s.url} — ${s.url}`));
  }
  if (short) lines.push("", "This is a simple conversational request — keep the reply short and direct.");
  return lines.join("\n");
}

/**
 * Compose the user-facing reply from finished work.
 * `short` mode is for simple conversational requests (fast-only path).
 */
export async function writeResponse(
  input: AuthorInput,
  opts: { short?: boolean } = {}
): Promise<{ text: string; usedFallback: boolean; truncated?: boolean }> {
  const extracted = extractFiles(input.subtasks);
  const messages: ChatMessage[] = [
    { role: "system", content: AUTHOR_SYSTEM },
    { role: "user", content: authorView(input, extracted, opts.short ?? false) },
  ];

  try {
    const res = await callAgentDetailed("author", messages);
    let text = res.text;
    let truncated = res.truncated;
    if (res.truncated) {
      const cont = await callAgentDetailed("author", [
        ...messages,
        { role: "assistant", content: res.text },
        {
          role: "user",
          content: "Your reply was cut off — continue exactly from where you stopped, no repetition.",
        },
      ]).catch(() => null);
      if (cont) {
        text += "\n" + cont.text;
        truncated = cont.truncated;
      }
    }
    text = injectFiles(text, extracted.files);
    return { text: text.trim() || deterministicReply(input), usedFallback: false, truncated };
  } catch (err) {
    console.warn(
      "[author] all providers failed — using deterministic reply:",
      err instanceof Error ? err.message.slice(0, 120) : err
    );
    return { text: fallbackResponse(input), usedFallback: true };
  }
}

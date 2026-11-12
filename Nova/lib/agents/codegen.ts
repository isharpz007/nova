import { callAgentDetailed, callJson, type ChatMessage } from "./llm";

// ---------------------------------------------------------------------------
// Per-file code generation — one model call per file so long deliverables
// don't get cut off by the output token limit. Each file retries once when
// its response was truncated or its code block left unclosed.
// ---------------------------------------------------------------------------

interface FileList {
  files?: string[];
}

/** Cheap heuristic: does this instruction ask for source code files? */
const CODE_HINT =
  /\b(code|implement|build|create|develop|program|endpoint|component|screen|widget|website|web page|landing page|app\b)\b/i;
const FILE_EXT_HINT = /\b[\w.-]+\.(html|css|js|ts|tsx|jsx|py|dart|java|go|rs|sql|vue|svelte)\b/i;

const LANG: Record<string, string> = {
  html: "html",
  css: "css",
  js: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  py: "python",
  dart: "dart",
  java: "java",
  go: "go",
  rs: "rust",
  sql: "sql",
  json: "json",
  md: "markdown",
};

/** Extract the first fenced code block (or the whole text when unfenced). */
function extractBlock(text: string): { code: string; closed: boolean } {
  const m = text.match(/```\s*[\w+-]*\s*\n([\s\S]*?)(```|$)/);
  if (!m) return { code: text.trim(), closed: true };
  return { code: m[1].replace(/\s+$/, ""), closed: m[2] === "```" };
}

/** One file per call. Retries once when the reply was truncated or the block unclosed. */
async function generateOneFile(file: string, prompt: string, system: string): Promise<string> {
  const ask = (extra = ""): ChatMessage[] => [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `${prompt}\n\nWrite the file "${file}". Return only the complete contents of this ` +
        `one file in one fenced code block — no commentary.${extra}`,
    },
  ];

  const res = await callAgentDetailed("developer", ask());
  let code = extractBlock(res.text).code;
  let closed = extractBlock(res.text).closed;
  if (res.truncated || !closed) {
    const cont = await callAgentDetailed(
      "developer",
      ask(
        " Your previous reply was cut off — continue exactly from where it stopped and output " +
          "only the remaining content in one fenced code block."
      )
    ).catch(() => null);
    if (cont) {
      code += extractBlock(cont.text).code;
      closed = extractBlock(cont.text).closed && !cont.truncated;
    }
  }

  const lang = LANG[file.split(".").pop() ?? ""] ?? "";
  return `#### ${file}\n\n\`\`\`${lang}\n${code}\n\`\`\``;
}

/**
 * Multi-file deliverable: ask for the file list, then generate one file per call.
 * Returns null when the deliverable isn't a set of source files (caller falls back
 * to a single-shot answer).
 */
export async function generateFiles(prompt: string, system: string): Promise<string | null> {
  if (!CODE_HINT.test(prompt) && !FILE_EXT_HINT.test(prompt)) return null;

  const list = await callJson<FileList>("developer", [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `${prompt}\n\nWhich source files are needed to produce this deliverable? Reply with ` +
        `ONLY a JSON object: {"files": ["path/name.ext", ...]} — an empty list if the ` +
        `deliverable is not a set of source files.`,
    },
  ]).catch((): FileList => ({ files: [] }));

  const files = (list.files ?? [])
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    .slice(0, 8);
  if (!files.length) return null;

  const parts: string[] = [];
  for (const file of files) parts.push(await generateOneFile(file, prompt, system));
  return parts.join("\n\n");
}

import type { Message } from "./types";

export interface CodeFile {
  path: string;
  language: string;
  content: string;
}

export interface Artifact {
  kind: "html" | "code";
  language: string;
  content: string;
  /** Virtual filename — a #### path header when present, else inferred. */
  path?: string;
  /** The artifact as a project: one entry per source file. */
  files?: CodeFile[];
}

const FENCE = /```\s*(\w*)\s*\n([\s\S]*?)```/g;

// A full HTML document emitted without code fences.
const RAW_HTML = /(<!doctype[\s\S]*?<\/html\s*>|<html[\s\S]*?<\/html\s*>)/i;

const EXT: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  bash: "sh",
  shell: "sh",
  yml: "yaml",
};

/** Inferred filename for a code block without a heading path. */
function inferPath(language: string, index: number): string {
  const lang = language.toLowerCase();
  if (lang === "html" || lang === "htm") return "index.html";
  if (lang === "css") return "style.css";
  if (lang === "js" || lang === "javascript") return "script.js";
  return `file-${index + 1}.${EXT[lang] ?? (lang || "txt")}`;
}

/** A heading/bold line immediately before a fence that is just a file path. */
function headingPath(content: string, fenceIndex: number): string | null {
  const lines = content.slice(0, fenceIndex).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue; // skip blank lines
    const m =
      t.match(/^#{1,6}\s+`?([\w./-]+\.\w{1,10})`?:?\s*$/) ??
      t.match(/^\*\*`?([\w./-]+\.\w{1,10})`?\*\*:?\s*$/) ??
      t.match(/^`?([\w./-]+\.\w{1,10})`?:\s*$/);
    return m ? m[1] : null;
  }
  return null;
}

function toArtifact(language: string, content: string, path: string): Artifact {
  const lang = language.toLowerCase();
  return {
    kind: lang === "html" || lang === "htm" ? "html" : "code",
    language: lang || "text",
    content,
    path,
    files: [{ path, language: lang || "text", content }],
  };
}

/** All fenced code blocks in a message, in order. Also catches a raw HTML doc. */
export function extractArtifacts(content: string): Artifact[] {
  const out: Artifact[] = [];
  for (const match of content.matchAll(FENCE)) {
    const code = match[2].trim();
    if (!code) continue;
    const path =
      headingPath(content, match.index ?? 0) ?? inferPath(match[1] || "", out.length);
    out.push(toArtifact(match[1] || "", code, path));
  }
  if (!out.length) {
    const raw = content.match(RAW_HTML);
    if (raw) out.push(toArtifact("html", raw[1].trim(), "index.html"));
  }
  return out;
}

/** Merge a message's code blocks into one project artifact with a file list. */
export function projectArtifact(arts: Artifact[]): Artifact | null {
  if (!arts.length) return null;
  const files: CodeFile[] = arts.map((a) => ({
    path: a.path ?? `file.${a.language}`,
    language: a.language,
    content: a.content,
  }));
  return {
    kind: files.some((f) => f.language === "html" || f.language === "htm") ? "html" : "code",
    language: files.length > 1 ? "project" : arts[0].language,
    content: files.map((f) => f.content).join("\n\n"),
    path: files[0].path,
    files,
  };
}

/** Message text with code blocks (and their path headings) removed — safe to show users. */
export function stripCode(content: string): string {
  return content
    .replace(FENCE, " ")
    .replace(RAW_HTML, " ")
    .replace(/^#{1,6}\s+`?[\w./-]+\.\w{1,10}`?:?\s*$/gm, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Builds the best live preview from a message's artifacts:
 * - html block → merge same-message css/js blocks into it
 * - svg block → wrap in a minimal HTML page
 * Returns null when nothing is renderable.
 */
export function buildPreview(artifacts: Artifact[]): Artifact | null {
  const html = artifacts.find((a) => a.kind === "html");
  if (html) {
    const css = artifacts.filter((a) => a.language === "css");
    const js = artifacts.filter((a) => a.language === "js" || a.language === "javascript");
    let doc = html.content;
    if (css.length) {
      const style = `<style>\n${css.map((c) => c.content).join("\n\n")}\n</style>`;
      doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, `${style}\n</head>`) : `${style}\n${doc}`;
    }
    if (js.length) {
      const script = `<script>\n${js.map((j) => j.content).join("\n\n")}\n</script>`;
      doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${script}\n</body>`) : `${doc}\n${script}`;
    }
    return { kind: "html", language: "html", content: doc };
  }

  const svg = artifacts.find((a) => a.language === "svg" || a.content.trimStart().startsWith("<svg"));
  if (svg) {
    return {
      kind: "html",
      language: "svg",
      content: `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${svg.content}</body></html>`,
    };
  }

  return null;
}

/** Preview for a multi-file project: html file + sibling css/js merged in. */
export function previewFromFiles(files: CodeFile[]): Artifact | null {
  return buildPreview(
    files.map((f) => ({
      kind: f.language === "html" || f.language === "htm" ? "html" : "code",
      language: f.language,
      content: f.content,
    }))
  );
}

/**
 * Finds the most recent artifact in assistant messages.
 * Prefers a renderable preview (html/svg); falls back to the newest code block.
 * The returned artifact carries the message's full file list when present.
 */
export function latestArtifact(messages: Message[]): Artifact | null {
  let lastCode: Artifact | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const artifacts = extractArtifacts(m.content);
    const preview = buildPreview(artifacts);
    const files = artifacts.map((a) => ({
      path: a.path ?? `file.${a.language}`,
      language: a.language,
      content: a.content,
    }));
    if (preview) return { ...preview, files, path: artifacts[0]?.path };
    if (!lastCode && artifacts.length > 0) lastCode = projectArtifact(artifacts);
  }
  return lastCode;
}

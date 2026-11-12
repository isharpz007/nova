"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { previewFromFiles, type Artifact, type CodeFile } from "@/lib/artifacts";
import { IconX, IconRefresh, IconMonitor, IconSmartphone } from "@/components/Icons";

interface CanvasPanelProps {
  artifact: Artifact | null;
  onClose: () => void;
}

const MIN_WIDTH = 340;
const MAX_RATIO = 0.85;

function basename(path: string) {
  return path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
}

function dirname(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function IconFolder({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function IconFile({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function CanvasPanel({ artifact, onClose }: CanvasPanelProps) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"preview" | "code">("preview");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [refreshKey, setRefreshKey] = useState(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [width, setWidth] = useState(() =>
    typeof window === "undefined"
      ? 480
      : Math.min(Math.round(window.innerWidth * 0.42), 640)
  );
  const asideRef = useRef<HTMLElement>(null);

  const art = artifact;
  const files = useMemo<CodeFile[]>(() => art?.files ?? [], [art]);
  const preview = useMemo(
    () => (art ? (files.length ? previewFromFiles(files) : art.kind === "html" ? art : null) : null),
    [art, files]
  );
  const canPreview = preview !== null;

  // Reset view and selection whenever a new artifact arrives.
  useEffect(() => {
    setView(files.length ? (previewFromFiles(files) ? "preview" : "code") : "preview");
    setActivePath(files[0]?.path ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [art?.content]);

  const activeFile = files.find((f) => f.path === activePath) ?? files[0] ?? null;
  const lineCount = activeFile ? activeFile.content.split("\n").length : 0;
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1).join("\n"),
    [lineCount]
  );

  // Group files by directory for the explorer tree.
  const tree = useMemo(() => {
    const groups = new Map<string, CodeFile[]>();
    for (const f of files) {
      const dir = dirname(f.path);
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(f);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth =
      asideRef.current?.getBoundingClientRect().width ?? width;
    const maxWidth = window.innerWidth * MAX_RATIO;

    const onMove = (ev: PointerEvent) => {
      const next = Math.min(
        Math.max(startWidth + (startX - ev.clientX), MIN_WIDTH),
        maxWidth
      );
      setWidth(Math.round(next));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function copy() {
    if (!art) return;
    try {
      await navigator.clipboard.writeText(
        view === "code" && activeFile ? activeFile.content : art.content
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — ignore.
    }
  }

  const tab = (v: "preview" | "code") => (
    <button
      onClick={() => setView(v)}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
        view === v
          ? "bg-slate-200 text-slate-800 dark:bg-white/15 dark:text-neutral-100"
          : "text-slate-500 dark:text-neutral-400 hover:text-slate-700 dark:hover:text-neutral-200"
      }`}
    >
      {v === "preview" ? "Preview" : "Code"}
    </button>
  );

  const fileRow = (f: CodeFile, indent = false) => (
    <button
      key={f.path}
      onClick={() => {
        setActivePath(f.path);
        setView("code");
      }}
      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] transition ${
        indent ? "pl-7" : ""
      } ${
        activeFile?.path === f.path
          ? "bg-teal-500/15 text-teal-600 dark:text-teal-300"
          : "text-slate-600 dark:text-neutral-300 hover:bg-slate-100 dark:hover:bg-white/5"
      }`}
    >
      <IconFile className="h-3 w-3 shrink-0" />
      <span className="truncate">{basename(f.path)}</span>
    </button>
  );

  return (
    <aside
      ref={asideRef}
      style={{ width }}
      className="relative flex fixed inset-y-0 right-0 z-40 max-w-[94vw] shrink-0 flex-col border-l border-slate-200 dark:border-white/10 bg-white dark:bg-[#303030] shadow-2xl lg:static lg:z-auto lg:shadow-none"
    >
      {/* Drag handle to resize the panel */}
      <div
        onPointerDown={startResize}
        className="absolute left-0 top-0 z-10 h-full w-2 -ml-1 cursor-col-resize hover:bg-teal-500/30 active:bg-teal-500/50 transition"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize canvas"
      />
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Canvas</span>
          {art && canPreview && view === "preview" && (
            <span className="flex items-center gap-1 rounded-full bg-teal-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-teal-500">
              <span className="h-1 w-1 rounded-full bg-teal-400 animate-pulse" />
              Live
            </span>
          )}
          {art && (
            <span className="rounded-full bg-slate-100 dark:bg-white/10 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:text-neutral-400 uppercase">
              {files.length > 1 ? `${files.length} files` : art.language}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {art && (
            <div className="flex items-center rounded-lg bg-slate-100 dark:bg-white/10 p-0.5 mr-1">
              {tab("preview")}
              {tab("code")}
            </div>
          )}
          {art && (
            <button
              onClick={copy}
              className="rounded-lg px-2.5 py-1 text-xs text-slate-500 dark:text-neutral-400 hover:bg-slate-100 dark:hover:bg-white/10 transition"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 transition"
            aria-label="Close canvas"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
      </div>
      {/* Browser toolbar */}
      {art && canPreview && view === "preview" && (
        <div className="flex items-center gap-2 border-b border-slate-200 dark:border-white/10 px-3 py-1.5">
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 transition"
            aria-label="Reload preview"
            title="Reload preview"
          >
            <IconRefresh className="h-3.5 w-3.5" />
          </button>
          <div className="flex-1 min-w-0 flex items-center gap-1.5 rounded-lg bg-slate-100 dark:bg-white/5 px-3 py-1.5 text-[11px] text-slate-500 dark:text-neutral-400">
            <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="10" width="16" height="11" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            <span className="truncate">nova / {activeFile?.path ?? `${art.language}-preview`}</span>
          </div>
          <button
            onClick={() => setDevice("desktop")}
            className={`rounded-md p-1.5 transition ${device === "desktop" ? "text-teal-500 bg-teal-500/10" : "text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10"}`}
            aria-label="Desktop preview"
            title="Desktop preview"
          >
            <IconMonitor className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setDevice("mobile")}
            className={`rounded-md p-1.5 transition ${device === "mobile" ? "text-teal-500 bg-teal-500/10" : "text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10"}`}
            aria-label="Mobile preview"
            title="Mobile preview"
          >
            <IconSmartphone className="h-3.5 w-3.5" />
          </button>
          <span className="shrink-0 text-[10px] text-slate-400 dark:text-neutral-500 w-8 text-right">
            {device === "mobile" ? "390px" : "100%"}
          </span>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {!art ? (
          <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-slate-400 dark:text-neutral-500 text-center max-w-xs">
              When the assistant creates a website, app, or snippet, a live
              preview will appear here.
            </p>
          </div>
        ) : canPreview && view === "preview" ? (
          <div className="h-full w-full bg-slate-200/60 dark:bg-black/30 flex justify-center overflow-auto">
            <iframe
              key={refreshKey}
              title="Canvas preview"
              sandbox="allow-scripts"
              srcDoc={preview.content}
              className={`h-full bg-white transition-all ${
                device === "mobile" ? "w-[390px] border-x border-slate-300 dark:border-white/10" : "w-full"
              }`}
            />
          </div>
        ) : files.length ? (
          /* VS Code-style explorer + editor */
          <div className="flex h-full min-h-0">
            {/* Explorer */}
            <div className="w-36 shrink-0 overflow-y-auto border-r border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#252526] py-2">
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-neutral-500">
                Explorer
              </p>
              {tree.map(([dir, dirFiles]) =>
                dir ? (
                  <details key={dir} open className="group/dir">
                    <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1 text-[11px] font-medium text-slate-500 dark:text-neutral-400 hover:bg-slate-100 dark:hover:bg-white/5">
                      <IconFolder className="h-3 w-3 shrink-0" />
                      <span className="truncate">{dir}/</span>
                    </summary>
                    {dirFiles.map((f) => fileRow(f, true))}
                  </details>
                ) : (
                  dirFiles.map((f) => fileRow(f))
                )
              )}
            </div>

            {/* Editor */}
            <div className="flex-1 min-w-0 flex flex-col bg-[#1e1e1e]">
              {/* Tabs */}
              <div className="flex overflow-x-auto border-b border-white/10 bg-[#252526]">
                {files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setActivePath(f.path)}
                    className={`shrink-0 border-r border-white/5 px-3 py-1.5 text-[11px] font-mono transition ${
                      activeFile?.path === f.path
                        ? "bg-[#1e1e1e] text-teal-300 border-t-2 border-t-teal-400"
                        : "text-neutral-400 hover:text-neutral-200 border-t-2 border-t-transparent"
                    }`}
                  >
                    {basename(f.path)}
                  </button>
                ))}
              </div>
              {/* Code with line numbers */}
              <div className="flex-1 min-h-0 overflow-auto flex font-mono text-[12px] leading-5">
                <pre className="select-none shrink-0 px-3 py-3 text-right text-neutral-600 border-r border-white/5">
                  {lineNumbers}
                </pre>
                <pre className="flex-1 p-3 text-neutral-200 whitespace-pre">
                  {activeFile?.content}
                </pre>
              </div>
            </div>
          </div>
        ) : (
          <pre className="h-full overflow-auto p-4 text-xs leading-relaxed text-slate-700 dark:text-neutral-300 whitespace-pre-wrap">
            {art.content}
          </pre>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-slate-200 dark:border-white/10 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-neutral-500">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          All changes saved
        </span>
        <span className="text-[10px] text-slate-400 dark:text-neutral-500 truncate">
          {art
            ? activeFile && view === "code"
              ? `${activeFile.path} · ${activeFile.language} · ${lineCount} lines`
              : art.kind === "html"
                ? "HTML · CSS · JavaScript"
                : art.language
            : "Idle"}
        </span>
      </div>
    </aside>
  );
}

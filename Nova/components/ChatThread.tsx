"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { isGuestClient } from "@/lib/guest";
import {
  extractArtifacts,
  latestArtifact,
  projectArtifact,
  stripCode,
  type Artifact,
} from "@/lib/artifacts";
import { CanvasPanel } from "@/components/CanvasPanel";
import { AgentPanel } from "@/components/AgentPanel";
import { AgentFlow } from "@/components/AgentFlow";
import type { AgentRun } from "@/components/AgentDashboard";
import { readSSE } from "@/lib/sse";
import type {
  AgentId,
  AgentMessage,
  RunResult,
  Task,
  TaskStatus,
} from "@/lib/agents/types";
import type { Source } from "@/lib/agents/outlook_llm";
import type { Subtask, TaskRun } from "@/lib/agents/taskrunner";

let activitySeq = 0;
function activity(content: string, type: AgentMessage["type"] = "info", from: AgentId | "user" = "lead"): AgentMessage {
  return {
    id: `a${++activitySeq}`,
    from,
    to: "team",
    type,
    content,
    at: new Date().toISOString(),
  };
}

const SUBTASK_STATUS: Record<string, TaskStatus> = {
  started: "in_progress",
  done: "completed",
  rescued: "rescued",
  failed: "failed_blocked",
};

async function fetchAssistantReply(
  history: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
  } catch {
    throw new Error("Nova couldn't respond. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || typeof data?.reply !== "string" || !data.reply.trim()) {
    throw new Error("Nova couldn't respond. Please try again.");
  }
  return data.reply;
}
import type { Conversation, Message } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
import { IconCanvas, IconSend, IconZap } from "@/components/Icons";

interface ChatThreadProps {
  conversationId?: string;
}

export function ChatThread({ conversationId }: ChatThreadProps) {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get("q") ?? "";
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [guest, setGuest] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [prelim, setPrelim] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const newestArtifact = useMemo(() => latestArtifact(messages), [messages]);
  const artifact = selectedArtifact ?? newestArtifact;

  // Newest artifact takes priority whenever a new message lands.
  useEffect(() => setSelectedArtifact(null), [messages.length]);

  useEffect(() => {
    const toggle = () => setCanvasOpen((o) => !o);
    const toggleAgents = () => setAgentsOpen((o) => !o);
    window.addEventListener("nova:toggle-canvas", toggle);
    window.addEventListener("nova:toggle-agents", toggleAgents);
    return () => {
      window.removeEventListener("nova:toggle-canvas", toggle);
      window.removeEventListener("nova:toggle-agents", toggleAgents);
    };
  }, []);

  useEffect(() => {
    setGuest(isGuestClient());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (isGuestClient()) return;
        const supabase = getSupabaseBrowser();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        if (conversationId) {
          const { data: conv, error } = await supabase
            .from("conversations")
            .select("*")
            .eq("id", conversationId)
            .eq("user_id", user.id)
            .single<Conversation>();
          if (error) throw error;
          const { data: msgs } = await supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", conv.id)
            .order("created_at", { ascending: true });
          if (!cancelled) {
            setConversation(conv);
            setMessages((msgs ?? []) as Message[]);
          }
        } else if (initial.trim()) {
          const { data: conv, error } = await supabase
            .from("conversations")
            .insert({ user_id: user.id, title: initial.trim().slice(0, 60) })
            .select("*")
            .single<Conversation>();
          if (error) throw error;
          const reply = await fetchAssistantReply([{ role: "user", content: initial.trim() }]);
          await supabase.from("messages").insert([
            { conversation_id: conv.id, user_id: user.id, role: "user", content: initial.trim() },
            { conversation_id: conv.id, user_id: user.id, role: "assistant", content: reply },
          ]);
          const { data: msgs } = await supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", conv.id)
            .order("created_at", { ascending: true });
          if (!cancelled) {
            setConversation(conv);
            setMessages((msgs ?? []) as Message[]);
            router.replace(`/chats/${conv.id}`);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load chat.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, awaitingReply]);

  async function send(e: React.FormEvent, fastOnly = false) {
    e.preventDefault();
    const content = input.trim();
    if (!content || awaitingReply) return;
    setInput("");

    try {
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      let conv = conversation;
      if (!conv) {
        const { data, error } = await supabase
          .from("conversations")
          .insert({ user_id: user.id, title: content.slice(0, 60) })
          .select("*")
          .single<Conversation>();
        if (error) throw error;
        conv = data;
        setConversation(conv);
        router.replace(`/chats/${conv.id}`);
      }

      const { data: userMsg, error: mErr } = await supabase
        .from("messages")
        .insert({ conversation_id: conv.id, user_id: user.id, role: "user", content })
        .select("*")
        .single<Message>();
      if (mErr) throw mErr;
      setMessages((prev) => [...prev, userMsg]);
      setAwaitingReply(true);

      const history = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      setRun({ tasks: {}, activity: [], agents: {}, done: false });
      setPrelim(null);
      setSources([]);
      let replyText = "";

      if (!fastOnly) {
        // Full run: orchestrator over SSE (plan -> subtasks -> merge).
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: content, history: history.slice(0, -1) }),
        });
        if (!res.ok) throw new Error("Nova couldn't respond. Please try again.");

        await readSSE(res, (event, data) => {
          if (event === "plan") {
            const p = data as { subtasks?: Subtask[] };
            const subs = p.subtasks ?? [];
            setRun((r) => {
              if (!r) return r;
              const tasks = { ...r.tasks };
              for (const s of subs) {
                tasks[s.id] = {
                  id: s.id,
                  description: s.instruction,
                  assignedTo: s.agent,
                  dependsOn: s.dependsOn ?? [],
                  status: "pending",
                };
              }
              return {
                ...r,
                tasks,
                agents: { ...r.agents, lead: "in_progress" },
                activity: [...r.activity, activity(`Plan created — ${subs.length} subtask${subs.length === 1 ? "" : "s"}`, "progress")],
              };
            });
          } else if (event.startsWith("subtask_")) {
            const d = data as { id: string; reason?: string; error?: string };
            const status = SUBTASK_STATUS[event.slice(8)];
            if (!status) return;
            if (d.id === "task") {
              setError(d.error ?? "The task failed.");
              return;
            }
            setRun((r) => {
              if (!r) return r;
              const t = r.tasks[d.id];
              const agent = t?.assignedTo;
              return {
                ...r,
                tasks: {
                  ...r.tasks,
                  [d.id]: {
                    ...(t ?? { id: d.id, description: d.id, assignedTo: "lead" as AgentId, dependsOn: [] }),
                    status,
                    ...(d.reason ? { reviewNote: `Rescued: ${d.reason}` } : {}),
                    ...(d.error ? { reviewNote: d.error } : {}),
                  },
                },
                agents: agent ? { ...r.agents, [agent]: status } : r.agents,
                activity:
                  event === "subtask_rescued" || event === "subtask_failed"
                    ? [...r.activity, activity(`${d.id} ${event === "subtask_rescued" ? "rescued" : "failed"}: ${d.reason ?? d.error}`, event === "subtask_rescued" ? "feedback" : "error", agent ?? "lead")]
                    : r.activity,
              };
            });
          } else if (event === "author_started") {
            setRun((r) => {
              if (!r) return r;
              return {
                ...r,
                tasks: {
                  ...r.tasks,
                  author: {
                    id: "author",
                    description: "Writing the response",
                    assignedTo: "author" as AgentId,
                    dependsOn: [],
                    status: "in_progress",
                  },
                },
                agents: { ...r.agents, author: "in_progress" },
                activity: [...r.activity, activity("Writing the response", "progress", "author")],
              };
            });
          } else if (event === "author_done") {
            setRun((r) => {
              if (!r) return r;
              const t = r.tasks.author;
              return {
                ...r,
                tasks: t ? { ...r.tasks, author: { ...t, status: "completed" as TaskStatus } } : r.tasks,
                agents: { ...r.agents, author: "completed" },
              };
            });
          } else if (event === "delivered") {
            setRun((r) => {
              if (!r) return r;
              return {
                ...r,
                agents: { ...r.agents, lead: "completed" },
                activity: [...r.activity, activity("Response delivered", "result")],
              };
            });
          } else if (event === "final") {
            const d = data as { text?: string };
            replyText = d.text ?? "";
            setRun((r) => {
              if (!r) return r;
              const t = r.tasks.author;
              return {
                ...r,
                tasks: t ? { ...r.tasks, author: { ...t, status: "completed" as TaskStatus } } : r.tasks,
                agents: { ...r.agents, author: "completed" },
              };
            });
          } else if (event === "run") {
            const tr = data as TaskRun;
            if (tr.final) replyText = tr.final;
            setSources(tr.sources ?? []);
            setRun((r) => {
              if (!r) return r;
              const tasks = { ...r.tasks };
              for (const s of tr.subtasks ?? []) {
                const prev = tasks[s.id];
                tasks[s.id] = {
                  id: s.id,
                  description: s.instruction,
                  assignedTo: s.agent,
                  dependsOn: s.dependsOn ?? [],
                  status: (SUBTASK_STATUS[s.status] ?? prev?.status ?? "pending") as TaskStatus,
                  ...(s.output ? { result: s.output.slice(0, 1500) } : {}),
                  ...(s.error ? { reviewNote: s.error } : prev?.reviewNote ? { reviewNote: prev.reviewNote } : {}),
                };
              }
              tasks["author"] = {
                id: "author",
                description: "Write the final response",
                assignedTo: "author",
                dependsOn: [],
                status: "completed",
              };
              return {
                ...r,
                tasks,
                agents: { ...r.agents, lead: "completed", author: "completed" },
                done: true,
              };
            });
          }
        });
      } else {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: history, stream: true, fast: true }),
        });
        if (!res.ok) throw new Error("Nova couldn't respond. Please try again.");

        await readSSE(res, (event, data) => {
        if (event === "activity") {
          const msg = data as AgentMessage;
          setRun((r) => r && { ...r, activity: [...r.activity, msg] });
        } else if (event === "task") {
          const t = data as Task;
          setRun((r) => r && { ...r, tasks: { ...r.tasks, [t.id]: t } });
        } else if (event === "agent_status") {
          const s = data as { agent: AgentId; status: TaskStatus };
          setRun((r) => r && { ...r, agents: { ...r.agents, [s.agent]: s.status } });
        } else if (event === "preliminary") {
          const p = data as { content?: string };
          if (p.content) setPrelim(p.content);
        } else if (event === "done") {
          const d = data as RunResult;
          replyText = d.reply;
          setPrelim(null);
          setRun((r) => {
            if (!r) return r;
            const tasks = { ...r.tasks };
            for (const t of d.tasks ?? []) tasks[t.id] = t;
            return { ...r, tasks, done: true };
          });
        } else if (event === "error") {
          setError("Some agents hit a problem — recovering…");
        }
      });
      }
      if (!replyText) throw new Error("Nova couldn't respond. Please try again.");

      const { data: reply, error: rErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conv.id,
          user_id: user.id,
          role: "assistant",
          content: replyText,
        })
        .select("*")
        .single<Message>();
      if (rErr) throw rErr;
      setMessages((prev) => [...prev, reply]);
      setAwaitingReply(false);
    } catch (err) {
      setAwaitingReply(false);
      setPrelim(null);
      setRun((r) => (r ? { ...r, done: true, errored: true } : r));
      setError(err instanceof Error ? err.message : "Failed to send message.");
    }
  }

  function renderMessage(m: Message) {
    const arts = extractArtifacts(m.content);
    const project = projectArtifact(arts);
    const text = arts.length ? stripCode(m.content) : m.content;
    return (
      <>
        {text && <span>{text}</span>}
        {project && (
          <button
            type="button"
            onClick={() => {
              setSelectedArtifact(project);
              setCanvasOpen(true);
            }}
            className="mt-1 flex w-full items-center justify-between gap-3 rounded-xl border border-slate-300 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-left text-xs hover:bg-white dark:hover:bg-black/30 transition"
          >
            <span className="flex items-center gap-2 font-medium text-slate-700 dark:text-neutral-200">
              <IconCanvas className="h-4 w-4 shrink-0 text-teal-500" />
              {project.files && project.files.length > 1
                ? `Project · ${project.files.length} files`
                : project.kind === "html"
                  ? "Web page"
                  : (project.path ?? `${project.language} code`)}
            </span>
            <span className="shrink-0 font-medium text-teal-600 dark:text-teal-400">
              Open in canvas
            </span>
          </button>
        )}
      </>
    );
  }

  if (guest) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link href="/chats" className="text-sm text-teal-600 dark:text-teal-400 hover:underline">
          ← All chats
        </Link>
        <div className="mt-4">
          <EmptyState
            title="Guest mode"
            message="You're browsing as a guest. Create a free account to start chats and save your data."
            action={
              <Link
                href="/signup"
                className="inline-block rounded-xl bg-teal-600 text-white px-4 py-2 text-sm font-medium"
              >
                Create account
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex flex-col flex-1 min-w-0 min-h-0 w-full max-w-3xl mx-auto px-4">
      <div className="flex items-center justify-between py-2 shrink-0">
        <div className="min-w-0">
          <Link href="/chats" className="text-xs text-slate-400 dark:text-neutral-500 hover:text-teal-600 dark:hover:text-teal-400 transition">
            ← All chats
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-medium text-slate-500 dark:text-neutral-400 truncate">
              {loading ? "Loading…" : (conversation?.title ?? "New chat")}
            </h1>
            {run && !run.done && (
              <span className="flex items-center gap-1 rounded-full bg-teal-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-teal-500">
                <span className="h-1 w-1 rounded-full bg-teal-400 animate-pulse" />
                Live
              </span>
            )}
          </div>
        </div>
      </div>

      {run && (
        <button
          type="button"
          onClick={() => setAgentsOpen((o) => !o)}
          className="shrink-0 mb-2 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#262626] px-3 pt-2 pb-1.5 text-left hover:border-teal-500/40 transition"
        >
          <span className="flex items-center gap-2 text-xs font-medium">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                run.done ? (run.errored ? "bg-red-500" : "bg-green-500") : "bg-teal-400 animate-pulse"
              }`}
            />
            Agent team
            <span className="font-normal text-slate-400 dark:text-neutral-500">
              {run.done ? (run.errored ? "Failed" : "Delivered") : "Working…"}
            </span>
            <span className="ml-auto text-[10px] text-slate-400">details ↗</span>
          </span>
          <AgentFlow run={run} compact />
        </button>
      )}

      {error && (
        <p className="mb-2 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-y-auto space-y-6 py-4">
        {!loading && messages.length === 0 && (
          <EmptyState
            title="Start a conversation"
            message="Type a message below — this chat is private to you."
          />
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[75%] rounded-3xl bg-slate-200 dark:bg-white/15 px-5 py-2.5 text-[15px] whitespace-pre-wrap text-slate-900 dark:text-neutral-100">
                {renderMessage(m)}
              </div>
            </div>
          ) : (
            <div key={m.id} className="text-[15px] leading-7 whitespace-pre-wrap text-slate-800 dark:text-neutral-100">
              {renderMessage(m)}
            </div>
          )
        )}
        {prelim && (
          <div className="text-[15px] leading-7 whitespace-pre-wrap text-slate-800 dark:text-neutral-100">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-teal-600 dark:text-teal-400">
              Fast Agent · preliminary
            </p>
            {prelim}
          </div>
        )}
        {sources.length > 0 && !awaitingReply && (
          <details className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-neutral-500 hover:text-teal-600 dark:hover:text-teal-400">
              Sources ({sources.length})
            </summary>
            <ol className="mt-2 space-y-1 text-xs">
              {sources.map((s, i) => (
                <li key={i} className="truncate">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-teal-600 dark:text-teal-400 hover:underline"
                  >
                    [{i + 1}] {s.title || s.url}
                  </a>
                </li>
              ))}
            </ol>
          </details>
        )}
        {awaitingReply && (
          <div className="flex items-center gap-1.5 py-2">
            <span className="typing-dot h-2 w-2 rounded-full bg-slate-400 dark:bg-neutral-400" />
            <span className="typing-dot h-2 w-2 rounded-full bg-slate-400 dark:bg-neutral-400" />
            <span className="typing-dot h-2 w-2 rounded-full bg-slate-400 dark:bg-neutral-400" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 pb-4 pt-1">
        <form
          onSubmit={send}
          className="flex items-end gap-1 rounded-[28px] border border-slate-200 dark:border-white/10 bg-white dark:bg-[#303030] px-2 py-2 shadow-sm"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(e);
              }
            }}
            rows={1}
            placeholder="Ask Nova anything…"
            className="flex-1 resize-none bg-transparent px-3 py-1.5 text-[15px] max-h-40 focus:outline-none placeholder:text-slate-400 dark:placeholder:text-neutral-500"
          />
          <button
            type="button"
            onClick={(e) => send(e, true)}
            disabled={!input.trim() || awaitingReply}
            className="rounded-full text-slate-400 dark:text-neutral-400 hover:text-teal-600 dark:hover:text-teal-400 disabled:opacity-40 p-2 transition"
            aria-label="Quick answer — Fast Agent only"
            title="Quick answer (Fast Agent only)"
          >
            <IconZap className="h-5 w-5" />
          </button>
          <button
            type="submit"
            disabled={!input.trim() || awaitingReply}
            className="rounded-full bg-slate-900 hover:bg-slate-700 dark:bg-white dark:hover:bg-neutral-200 dark:text-slate-900 disabled:opacity-30 text-white p-2 transition"
            aria-label="Send message"
            title="Send — full agent team"
          >
            <IconSend className="h-5 w-5" />
          </button>
        </form>
        <p className="mt-2 text-center text-[11px] text-slate-400 dark:text-neutral-500">
          Nova can make mistakes. Check important info.
        </p>
      </div>
      </div>
      {agentsOpen && (
        <AgentPanel run={run} onClose={() => setAgentsOpen(false)} />
      )}
      {canvasOpen && (
        <CanvasPanel artifact={artifact} onClose={() => setCanvasOpen(false)} />
      )}
    </div>
  );
}

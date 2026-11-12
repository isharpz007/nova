"use client";

import { useState } from "react";
import { AgentFlow } from "@/components/AgentFlow";
import type {
  AgentId,
  AgentMessage,
  MessageType,
  Task,
  TaskStatus,
} from "@/lib/agents/types";

export interface AgentRun {
  tasks: Record<string, Task>;
  activity: AgentMessage[];
  agents: Partial<Record<AgentId, TaskStatus>>;
  done: boolean;
  errored?: boolean;
}

const AGENTS: Array<{ id: AgentId; name: string; role: string }> = [
  { id: "lead", name: "Lead Agent", role: "Coordinator & Supervisor" },
  { id: "fast", name: "Fast Agent", role: "Immediate Response (runs in parallel)" },
  { id: "interviewer", name: "Interviewer Agent", role: "User Interaction & Requirements" },
  { id: "designer", name: "Designer Agent", role: "UI/UX & Planning" },
  { id: "developer", name: "Developer Agent", role: "Development & Execution" },
  { id: "author", name: "Author Agent", role: "Author: writes the final response" },
];

const STATUS_META: Record<TaskStatus, { label: string; dot: string; badge: string }> = {
  pending: {
    label: "Pending",
    dot: "bg-slate-400",
    badge: "bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-neutral-300",
  },
  assigned: {
    label: "Assigned",
    dot: "bg-blue-400",
    badge: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  },
  in_progress: {
    label: "In Progress",
    dot: "bg-blue-500 animate-pulse",
    badge: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  },
  awaiting_information: {
    label: "Awaiting Info",
    dot: "bg-yellow-400 animate-pulse",
    badge: "bg-yellow-50 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-300",
  },
  under_review: {
    label: "Under Review",
    dot: "bg-yellow-400 animate-pulse",
    badge: "bg-yellow-50 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-300",
  },
  revision_required: {
    label: "Revision Required",
    dot: "bg-orange-400",
    badge: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  },
  completed: {
    label: "Completed",
    dot: "bg-green-500",
    badge: "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  },
  rescued: {
    label: "Rescued",
    dot: "bg-orange-500",
    badge: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  },
  failed_blocked: {
    label: "Failed / Blocked",
    dot: "bg-red-500",
    badge: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  },
};

const IDLE_META = { label: "Idle", dot: "bg-slate-300 dark:bg-neutral-600", badge: STATUS_META.pending.badge };

const MSG_DOT: Record<MessageType, string> = {
  info: "bg-blue-400",
  task: "bg-slate-400",
  progress: "bg-blue-500",
  clarification: "bg-yellow-400",
  feedback: "bg-orange-400",
  result: "bg-green-500",
  error: "bg-red-500",
};

function statusOf(status: TaskStatus | undefined) {
  return status ? STATUS_META[status] : IDLE_META;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

interface Detail {
  label: string;
  value: string;
}

function agentDetails(agent: AgentId, run: AgentRun): Detail[] {
  const tasks = Object.values(run.tasks).filter((t) => t.assignedTo === agent);
  const done = tasks.filter((t) => t.status === "completed").length;
  const reviews = run.activity.filter(
    (m) => m.to === "developer" && m.type === "feedback" && m.content.startsWith("Revision")
  );

  switch (agent) {
    case "lead": {
      const reviewTask = [...tasks].reverse().find((t) => t.reviewNote);
      return [
        { label: "Tasks coordinated", value: String(tasks.length) },
        { label: "Completed", value: String(done) },
        ...(reviewTask ? [{ label: "Latest review", value: truncate(reviewTask.reviewNote!, 90) }] : []),
      ];
    }
    case "interviewer": {
      const questions = run.activity.filter(
        (m) => m.from === "interviewer" && m.type === "clarification"
      ).length;
      const reqTask = tasks.find((t) => t.result);
      return [
        { label: "Questions asked", value: String(questions) },
        { label: "Request", value: questions ? "Needed clarification" : reqTask ? "Clear" : "Checking…" },
        ...(reqTask ? [{ label: "Requirements", value: truncate(reqTask.result!, 90) }] : []),
      ];
    }
    case "designer": {
      const specTask = tasks.find((t) => t.result);
      return [
        { label: "Plan", value: specTask ? "Delivered" : tasks.length ? "Working…" : "—" },
        ...(specTask ? [{ label: "Spec", value: truncate(specTask.result!, 90) }] : []),
      ];
    }
    case "fast": {
      const answered = tasks.filter((t) => t.result);
      const attempts = run.activity.filter(
        (m) => m.from === "fast" && m.type === "progress"
      ).length;
      return [
        { label: "Answers given", value: String(answered.length) },
        { label: "Attempts", value: String(attempts) },
        ...(answered.length ? [{ label: "Answer", value: truncate(answered[0].result!, 90) }] : []),
      ];
    }
    case "developer": {
      const attempts = run.activity.filter(
        (m) => m.from === "developer" && m.type === "progress"
      ).length;
      const impl = tasks.find((t) => t.result);
      return [
        { label: "Attempts", value: String(attempts) },
        { label: "Revisions", value: String(reviews.length) },
        ...(impl ? [{ label: "Result", value: truncate(impl.result!, 90) }] : []),
      ];
    }
    case "author": {
      const writing = tasks.some((t) => t.status === "in_progress");
      const done_ = tasks.some((t) => t.status === "completed");
      return [
        { label: "Reply", value: done_ ? "Written" : writing ? "Writing…" : "—" },
        { label: "Audience", value: "User-facing text only" },
      ];
    }
  }
}

function AgentCard({
  id,
  name,
  role,
  run,
}: {
  id: AgentId;
  name: string;
  role: string;
  run: AgentRun;
}) {
  const myTasks = Object.values(run.tasks).filter((t) => t.assignedTo === id);
  const active = myTasks.filter(
    (t) => t.status !== "completed" && t.status !== "failed_blocked" && t.status !== "rescued"
  );
  const current = active[active.length - 1];
  const meta = statusOf(run.agents[id]);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold truncate">{name}</p>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.badge}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
          {meta.label}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-400 dark:text-neutral-500">{role}</p>
      {current && (
        <p className="mt-2 text-xs text-slate-600 dark:text-neutral-300 truncate">
          {current.id}: {truncate(current.description, 60)}
        </p>
      )}
      <dl className="mt-2 space-y-1">
        {agentDetails(id, run).map((d) => (
          <div key={d.label} className="flex gap-2 text-[11px]">
            <dt className="shrink-0 text-slate-400 dark:text-neutral-500">{d.label}:</dt>
            <dd className="text-slate-600 dark:text-neutral-300 break-words">{d.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Timeline({ activity }: { activity: AgentMessage[] }) {
  return (
    <ol className="max-h-44 overflow-y-auto space-y-1.5 pr-1">
      {activity.map((m) => (
        <li key={m.id} className="flex items-start gap-2 text-xs">
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${MSG_DOT[m.type]}`} />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-slate-700 dark:text-neutral-200 capitalize">
              {m.from === "user" ? "You" : `${m.from} agent`}
            </span>
            <span className="text-slate-400 dark:text-neutral-500"> → </span>
            <span className="text-slate-500 dark:text-neutral-400 capitalize">
              {m.to === "team" ? "team" : m.to === "user" ? "you" : `${m.to} agent`}
            </span>
            <p className="text-slate-600 dark:text-neutral-300 break-words">
              {truncate(m.content, 140)}
            </p>
          </div>
          <time className="shrink-0 text-[10px] text-slate-400 dark:text-neutral-600">
            {new Date(m.at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        </li>
      ))}
      {activity.length === 0 && (
        <li className="text-xs text-slate-400 dark:text-neutral-500">Waiting for agents…</li>
      )}
    </ol>
  );
}

function TaskRow({ task }: { task: Task }) {
  const meta = STATUS_META[task.status];
  return (
    <div className="rounded-lg border border-slate-200 dark:border-white/10 px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[10px] text-slate-400 dark:text-neutral-500">{task.id}</span>
        <span className="text-xs font-medium flex-1 min-w-0 truncate">{task.description}</span>
        <span className="text-[10px] text-slate-400 dark:text-neutral-500 capitalize">
          {task.assignedTo}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.badge}`}>
          {meta.label}
        </span>
      </div>
      {task.reviewNote && (
        <p className="mt-1 text-[11px] text-orange-600 dark:text-orange-300 break-words">
          Review: {task.reviewNote}
        </p>
      )}
    </div>
  );
}

export function AgentDashboard({ run, embedded }: { run: AgentRun; embedded?: boolean }) {
  const [open, setOpen] = useState(true);
  const tasks = Object.values(run.tasks);
  const completed = tasks.filter((t) => t.status === "completed").length;
  const revisions = run.activity.filter(
    (m) => m.to === "developer" && m.type === "feedback" && m.content.startsWith("Revision")
  ).length;
  const approved =
    run.done &&
    tasks.some((t) => t.assignedTo === "lead" && t.status === "completed") &&
    !run.errored;

  const body = (
    <div className={embedded ? "p-3 space-y-3" : "border-t border-slate-200 dark:border-white/10 p-3 space-y-3"}>
      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-neutral-500">
          Agent workflow
        </p>
        <AgentFlow run={run} />
      </div>

      <div className="grid grid-cols-1 gap-2">
        {AGENTS.map((a) => (
          <AgentCard key={a.id} id={a.id} name={a.name} role={a.role} run={run} />
        ))}
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-neutral-500">
          Live timeline
        </p>
        <Timeline activity={run.activity} />
      </div>

      {tasks.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-neutral-500 hover:text-slate-600 dark:hover:text-neutral-300">
            Tasks ({completed}/{tasks.length} completed)
          </summary>
          <div className="mt-2 space-y-1.5">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        </details>
      )}

      {run.activity.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-neutral-500 hover:text-slate-600 dark:hover:text-neutral-300">
            Agent communication ({run.activity.length} messages)
          </summary>
          <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {run.activity.map((m) => (
              <div
                key={m.id}
                className="rounded-lg bg-slate-50 dark:bg-white/5 px-3 py-2 text-xs"
              >
                <p className="font-medium text-slate-600 dark:text-neutral-300 capitalize">
                  {m.from === "user" ? "You" : `${m.from} agent`}
                  <span className="text-slate-400 dark:text-neutral-500"> → </span>
                  {m.to === "team" ? "team" : m.to === "user" ? "you" : `${m.to} agent`}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-slate-600 dark:text-neutral-300">
                  {truncate(m.content, 400)}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div className="mb-3 rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#262626] overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-white/5 transition"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <span
            className={`h-2 w-2 rounded-full ${
              run.done ? (run.errored ? "bg-red-500" : "bg-green-500") : "bg-blue-500 animate-pulse"
            }`}
          />
          Agent team
          <span className="text-xs font-normal text-slate-400 dark:text-neutral-500">
            {run.done
              ? run.errored
                ? "Pipeline failed — fallback used"
                : approved
                  ? `Delivered · ${completed}/${tasks.length} tasks · ${revisions} revision${revisions === 1 ? "" : "s"}`
                  : "Finished"
              : "Working…"}
          </span>
        </span>
        <span className="text-xs text-slate-400">{open ? "Hide" : "Show"}</span>
      </button>

      {open && body}
    </div>
  );
}

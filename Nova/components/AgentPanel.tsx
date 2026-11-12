"use client";

import { AgentDashboard, type AgentRun } from "@/components/AgentDashboard";
import { IconX } from "@/components/Icons";

interface AgentPanelProps {
  run: AgentRun | null;
  onClose: () => void;
}

/** Right-side panel showing the agent workflow — never covers the conversation. */
export function AgentPanel({ run, onClose }: AgentPanelProps) {
  return (
    <aside className="flex fixed inset-y-0 right-0 z-40 w-[380px] max-w-[92vw] shrink-0 flex-col border-l border-slate-200 dark:border-white/10 bg-white dark:bg-[#262626] shadow-2xl lg:static lg:z-auto lg:shadow-none">
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/10 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span
            className={`h-2 w-2 rounded-full ${
              !run
                ? "bg-slate-400"
                : run.done
                  ? run.errored
                    ? "bg-red-500"
                    : "bg-green-500"
                  : "bg-teal-400 animate-pulse"
            }`}
          />
          Agent team
          <span className="text-xs font-normal text-slate-400 dark:text-neutral-500">
            {!run ? "Idle" : run.done ? (run.errored ? "Failed" : "Delivered") : "Working…"}
          </span>
        </span>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 transition"
          aria-label="Close agent panel"
        >
          <IconX className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {run ? (
          <AgentDashboard run={run} embedded />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-slate-400 dark:text-neutral-500 text-center max-w-xs">
              Send a message and the agent team will appear here — you can
              watch each agent light up as it works.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

"use client";

import type React from "react";
import type { AgentId, TaskStatus } from "@/lib/agents/types";
import type { AgentRun } from "@/components/AgentDashboard";
import {
  IconCanvas,
  IconChat,
  IconCode,
  IconUser,
  IconZap,
} from "@/components/Icons";

/**
 * n8n-style workflow graph of the 5-agent team.
 * Nodes light up with live status; edges "flow" while a link is active.
 *
 * Layout (viewBox 740x300):
 *   start ──► Lead ──► Fast (parallel, top)
 *             Lead ──► Interviewer ──► Designer ──► Developer
 *             Developer ──► back to Lead (review loop, bottom)
 */

const W = 740;
const H = 300;

const NODE: Record<
  AgentId,
  { x: number; y: number; label: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  lead: { x: 165, y: 140, label: "Lead", Icon: IconUser },
  fast: { x: 335, y: 55, label: "Fast", Icon: IconZap },
  interviewer: { x: 335, y: 225, label: "Interviewer", Icon: IconChat },
  designer: { x: 490, y: 225, label: "Designer", Icon: IconCanvas },
  developer: { x: 645, y: 225, label: "Developer", Icon: IconCode },
  author: { x: 645, y: 55, label: "Author", Icon: IconChat },
};

// Compact strip: single horizontal row in a 740x170 viewBox.
const NODE_COMPACT: typeof NODE = {
  lead: { x: 105, y: 85, label: "Lead", Icon: IconUser },
  fast: { x: 215, y: 85, label: "Fast", Icon: IconZap },
  interviewer: { x: 330, y: 85, label: "Interviewer", Icon: IconChat },
  designer: { x: 445, y: 85, label: "Designer", Icon: IconCanvas },
  developer: { x: 560, y: 85, label: "Developer", Icon: IconCode },
  author: { x: 680, y: 85, label: "Author", Icon: IconChat },
};

const START = { x: 45, y: 140 };
const START_COMPACT = { x: 30, y: 85 };

// [path, activeWhen] — activeWhen receives run to decide if the edge is flowing.
const EDGES: Array<{ d: string; active: (r: AgentRun) => boolean }> = [
  { d: "M63 140 L129 140", active: (r) => !r.done }, // start -> lead
  { d: "M201 140 C245 140 245 55 299 55", active: (r) => r.agents.fast === "in_progress" }, // lead -> fast
  { d: "M201 148 C250 148 250 225 299 225", active: (r) => r.agents.interviewer === "in_progress" }, // lead -> interviewer
  { d: "M371 225 L454 225", active: (r) => r.agents.designer === "in_progress" }, // interviewer -> designer
  { d: "M526 225 L609 225", active: (r) => r.agents.developer === "in_progress" }, // designer -> developer
  { d: "M645 261 C645 290 165 290 165 176", active: (r) => r.agents.lead === "under_review" }, // developer -> lead (review loop)
  { d: "M645 189 L645 91", active: (r) => r.agents.author === "in_progress" }, // developer -> author (write reply)
];

const EDGES_COMPACT: typeof EDGES = [
  { d: "M46 85 L69 85", active: (r) => !r.done },
  { d: "M141 85 L179 85", active: (r) => r.agents.fast === "in_progress" },
  { d: "M251 85 L294 85", active: (r) => r.agents.interviewer === "in_progress" },
  { d: "M366 85 L409 85", active: (r) => r.agents.designer === "in_progress" },
  { d: "M481 85 L524 85", active: (r) => r.agents.developer === "in_progress" },
  { d: "M596 85 L644 85", active: (r) => r.agents.author === "in_progress" },
  { d: "M560 121 C560 165 105 165 105 121", active: (r) => r.agents.lead === "under_review" }, // review loop
];

const RING: Record<string, string> = {
  idle: "border-neutral-700 text-neutral-500",
  in_progress: "border-teal-400 text-teal-300 animate-pulse shadow-[0_0_14px_rgba(45,212,191,0.4)]",
  under_review: "border-yellow-400 text-yellow-300 animate-pulse",
  completed: "border-green-500 text-green-400",
  rescued: "border-orange-400 text-orange-300",
  failed_blocked: "border-red-500 text-red-400",
};

function ringOf(status: TaskStatus | undefined): string {
  if (!status) return RING.idle;
  return RING[status] ?? (status === "completed" ? RING.completed : RING.idle);
}

function NodeBox({
  x,
  y,
  label,
  status,
  compact,
  viewW = W,
  viewH = H,
  children,
}: {
  x: number;
  y: number;
  label: string;
  status?: TaskStatus;
  compact?: boolean;
  viewW?: number;
  viewH?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="absolute flex flex-col items-center gap-0.5 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${(x / viewW) * 100}%`, top: `${(y / viewH) * 100}%` }}
    >
      <div
        className={`flex ${compact ? "h-8 w-8 rounded-lg" : "h-11 w-11 rounded-xl"} items-center justify-center border-2 bg-[#1e1e1e] ${ringOf(status)} transition-all`}
      >
        {children}
      </div>
      <span className={`${compact ? "text-[8px]" : "text-[10px]"} font-medium text-neutral-400`}>
        {label}
      </span>
    </div>
  );
}

export function AgentFlow({ run, compact }: { run: AgentRun; compact?: boolean }) {
  const h = compact ? 170 : H;
  const nodes = compact ? NODE_COMPACT : NODE;
  const edges = compact ? EDGES_COMPACT : EDGES;
  const start = compact ? START_COMPACT : START;
  const vbW = compact ? W : W;
  const vbH = compact ? 170 : H;
  return (
    <div
      className={`relative w-full rounded-xl bg-[#141414] border border-white/10 overflow-hidden ${compact ? "rounded-lg" : ""}`}
    >
      {/* dotted grid background */}
      <div
        className="absolute inset-0 opacity-[0.15]"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.35) 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      />
      <div className="relative w-full" style={{ aspectRatio: `${W}/${h}` }}>
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${vbW} ${vbH}`}
          preserveAspectRatio="none"
        >
          {edges.map((e, i) => {
            const active = e.active(run);
            return (
              <path
                key={i}
                d={e.d}
                fill="none"
                stroke={active ? "#2dd4bf" : "#3f3f3f"}
                strokeWidth={active ? 2 : 1.5}
                strokeDasharray={active ? "6 4" : undefined}
                className={active ? "edge-flow" : undefined}
              />
            );
          })}
        </svg>

        {/* start node */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${(start.x / vbW) * 100}%`, top: `${(start.y / vbH) * 100}%` }}
        >
          <div
            className={`flex ${compact ? "h-6 w-6" : "h-9 w-9"} items-center justify-center rounded-full border-2 transition-all ${
              run.done ? "border-green-500 text-green-400" : "border-teal-500 text-teal-400"
            } bg-[#1e1e1e]`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>

        {(Object.keys(nodes) as AgentId[]).map((id) => {
          const n = nodes[id];
          return (
            <NodeBox
              key={id}
              x={n.x}
              y={n.y}
              label={n.label}
              status={run.agents[id]}
              compact={compact}
              viewW={vbW}
              viewH={vbH}
            >
              <n.Icon className={compact ? "h-4 w-4" : "h-5 w-5"} />
            </NodeBox>
          );
        })}
      </div>
    </div>
  );
}

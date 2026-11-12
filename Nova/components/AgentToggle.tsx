"use client";

import { usePathname } from "next/navigation";
import { IconAgents } from "./Icons";

/** Header button that toggles the agent workflow panel. Only relevant on chat pages. */
export function AgentToggle() {
  const pathname = usePathname();
  if (!pathname?.startsWith("/chats")) return null;

  return (
    <button
      onClick={() => window.dispatchEvent(new Event("nova:toggle-agents"))}
      className="rounded-lg p-2 text-slate-500 dark:text-neutral-400 hover:bg-slate-100 dark:hover:bg-white/10 transition"
      aria-label="Toggle agent view"
      title="Agent team"
    >
      <IconAgents className="h-5 w-5" />
    </button>
  );
}

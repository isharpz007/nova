"use client";

import { usePathname } from "next/navigation";
import { IconCanvas } from "./Icons";

/** Header button that toggles the chat canvas. Only relevant on chat pages. */
export function CanvasToggle() {
  const pathname = usePathname();
  if (!pathname?.startsWith("/chats")) return null;

  return (
    <button
      onClick={() => window.dispatchEvent(new Event("nova:toggle-canvas"))}
      className="rounded-lg p-2 text-slate-500 dark:text-neutral-400 hover:bg-slate-100 dark:hover:bg-white/10 transition"
      aria-label="Toggle canvas"
      title="Canvas"
    >
      <IconCanvas className="h-5 w-5" />
    </button>
  );
}

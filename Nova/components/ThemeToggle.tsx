"use client";

import { useTheme } from "@/components/ThemeProvider";
import { IconMoon, IconSun } from "@/components/Icons";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="rounded-lg p-2 text-slate-500 dark:text-neutral-400 hover:bg-slate-100 dark:hover:bg-white/10 transition"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? <IconSun className="h-5 w-5" /> : <IconMoon className="h-5 w-5" />}
    </button>
  );
}

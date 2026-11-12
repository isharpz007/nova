"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { isGuestClient } from "@/lib/guest";
import type { Conversation } from "@/lib/types";
import {
  IconAgents,
  IconBell,
  IconChat,
  IconHome,
  IconMoon,
  IconPlus,
  IconSettings,
  IconSun,
  IconUser,
} from "@/components/Icons";
import { useTheme } from "@/components/ThemeProvider";
import { SignOutButton } from "@/components/SignOutButton";

const NAV = [
  { href: "/", label: "Home", Icon: IconHome },
  { href: "/chats", label: "Chats", Icon: IconChat },
  { href: "/models", label: "Models", Icon: IconAgents },
  { href: "/notifications", label: "Notifications", Icon: IconBell },
  { href: "/profile", label: "Profile", Icon: IconUser },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  const [chats, setChats] = useState<Conversation[]>([]);
  const [userName, setUserName] = useState("You");

  useEffect(() => {
    async function load() {
      if (isGuestClient()) return;
      try {
        const supabase = getSupabaseBrowser();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        setUserName(
          user.user_metadata?.full_name?.split(" ")[0] ??
            user.email?.split("@")[0] ??
            "You"
        );
        const { data } = await supabase
          .from("conversations")
          .select("*")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(12);
        setChats((data ?? []) as Conversation[]);
      } catch {
        // Sidebar history is best-effort.
      }
    }
    load();
  }, [pathname]);

  return (
    <aside className="hidden md:flex flex-col w-64 shrink-0 h-full bg-gradient-to-b from-[#181818] to-[#141414] border-r border-white/5 text-neutral-300">
      <div className="p-3">
        <Link
          href="/"
          className="group flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold text-white hover:bg-white/5 transition"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-cyan-600 text-sm text-white shadow-lg shadow-teal-500/20 group-hover:shadow-teal-500/40 transition-shadow">
            ✦
          </span>
          Nova
        </Link>
        <p className="px-3 pt-4 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-600">
          Workspace
        </p>
        <Link
          href="/chats/new"
          className="flex items-center gap-2.5 rounded-xl border border-teal-500/30 bg-teal-500/10 px-3 py-2.5 text-sm font-medium text-teal-300 hover:bg-teal-500/20 hover:border-teal-400/50 transition-all"
        >
          <IconPlus className="h-4 w-4" /> New chat
        </Link>
      </div>

      <nav className="sidebar-scroll flex-1 overflow-y-auto px-3 pb-2 space-y-0.5">
        {NAV.filter((n) => n.href !== "/chats").map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-all ${
                active
                  ? "bg-white/10 text-white"
                  : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200 hover:translate-x-0.5"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-white" />
              )}
              <Icon className={`h-4 w-4 ${active ? "text-white" : ""}`} />
              {label}
            </Link>
          );
        })}

        {chats.length > 0 && (
          <>
            <p className="flex items-center justify-between px-3 pt-5 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-600">
              Recent chats
              <svg className="h-3 w-3 text-neutral-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </p>
            {chats.map((c) => (
              <Link
                key={c.id}
                href={`/chats/${c.id}`}
                className={`flex items-center gap-2.5 truncate rounded-xl px-3 py-2 text-sm transition-all ${
                  pathname === `/chats/${c.id}`
                    ? "bg-white/10 text-white"
                    : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
                }`}
              >
                <IconChat
                  className={`h-3.5 w-3.5 shrink-0 ${
                    pathname === `/chats/${c.id}` ? "text-white" : "text-neutral-600"
                  }`}
                />
                <span className="truncate">{c.title}</span>
              </Link>
            ))}
          </>
        )}
      </nav>

      <div className="border-t border-white/5 p-3 space-y-2">
        <button
          onClick={toggle}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-neutral-400 hover:bg-white/5 hover:text-neutral-200 transition"
        >
          {theme === "dark" ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
        <div className="flex items-center gap-2.5 rounded-xl bg-white/[0.04] border border-white/5 px-3 py-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-cyan-600 text-xs font-bold text-white">
            {userName.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-neutral-200">{userName}</p>
            <p className="text-[10px] text-neutral-500">Personal workspace</p>
          </div>
        </div>
        <SignOutButton className="w-full justify-start !border-0 !bg-transparent hover:!bg-white/5 text-neutral-400 hover:text-neutral-200" />
      </div>
    </aside>
  );
}

import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";
import { isGuestServer } from "@/lib/guest-server";
import type { Profile } from "@/lib/types";
import { Sidebar } from "@/components/Sidebar";
import { BottomNav } from "@/components/BottomNav";
import { SignOutButton } from "@/components/SignOutButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CanvasToggle } from "@/components/CanvasToggle";
import { AgentToggle } from "@/components/AgentToggle";
import { IconSettings } from "@/components/Icons";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const guest = await isGuestServer();

  let name = "Guest";
  if (!guest) {
    const supabase = await getSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single<Profile>();

    name = profile?.full_name?.split(" ")[0] ?? user.email?.split("@")[0] ?? "there";
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="shrink-0 sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 dark:border-white/10 bg-white/80 dark:bg-[#212121]/80 backdrop-blur px-4 md:px-8 py-3">
          <div className="flex items-center gap-1 min-w-0">
            <CanvasToggle />
            <AgentToggle />
            <div className="md:hidden font-semibold text-white dark:text-white">
              <span className="text-teal-500">✦</span> Nova
            </div>
            <div className="hidden md:block text-sm text-slate-500 dark:text-neutral-400">
              Hi, <span className="font-medium text-slate-800 dark:text-neutral-100">{name}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <ThemeToggle />
            <Link
              href="/settings"
              className="md:hidden rounded-lg p-2 text-slate-500 dark:text-neutral-400 hover:bg-slate-100 dark:hover:bg-white/10"
              aria-label="Settings"
            >
              <IconSettings className="h-5 w-5" />
            </Link>
            <SignOutButton className="hidden sm:block" />
          </div>
        </header>
        <main className="flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-contain px-4 md:px-8 py-6 pb-24 md:pb-10 max-w-5xl w-full mx-auto">
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  );
}

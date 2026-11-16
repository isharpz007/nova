"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { isGuestClient } from "@/lib/guest";
import type { Conversation, Notification, Profile, ProjectSummary } from "@/lib/types";
import { StatCard } from "@/components/StatCard";
import { ActivityList } from "@/components/ActivityList";
import { StatCardsSkeleton, CardSkeleton } from "@/components/Skeletons";
import { EmptyState } from "@/components/EmptyState";
import { IconChat, IconPlus, IconSend, IconTrash } from "@/components/Icons";

interface DashboardData {
  profile: Profile | null;
  conversations: Conversation[];
  messageCount: number;
  notifications: Notification[];
  projects: ProjectSummary[];
}

export default function HomePage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [guest, setGuest] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newWidth, setNewWidth] = useState(1280);
  const [newHeight, setNewHeight] = useState(720);
  const [creating, setCreating] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    setGuest(isGuestClient());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (isGuestClient()) {
          setData({ profile: null, conversations: [], messageCount: 0, notifications: [], projects: [] });
          return;
        }
        const supabase = getSupabaseBrowser();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        const [profileRes, convRes, msgRes, notifRes, projRes] = await Promise.all([
          supabase.from("profiles").select("*").eq("id", user.id).single<Profile>(),
          supabase
            .from("conversations")
            .select("*")
            .eq("user_id", user.id)
            .order("updated_at", { ascending: false })
            .limit(50),
          supabase.from("messages").select("id", { count: "exact", head: true }).eq("user_id", user.id),
          supabase
            .from("notifications")
            .select("*")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(20),
          supabase
            .from("projects")
            .select("id,user_id,title,width,height,background,fps,created_at,updated_at")
            .eq("user_id", user.id)
            .order("updated_at", { ascending: false })
            .limit(12),
        ]);

        if (convRes.error) throw convRes.error;
        if (!cancelled) {
          setData({
            profile: profileRes.data,
            conversations: (convRes.data ?? []) as Conversation[],
            messageCount: msgRes.count ?? 0,
            notifications: (notifRes.data ?? []) as Notification[],
            projects: (projRes.data ?? []) as ProjectSummary[],
          });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load dashboard.");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <EmptyState
        title="Couldn't load your dashboard"
        message={error}
        action={
          <button
            onClick={() => window.location.reload()}
            className="rounded-xl bg-teal-600 text-white px-4 py-2 text-sm font-medium"
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <StatCardsSkeleton />
        <div className="grid md:grid-cols-2 gap-6">
          <CardSkeleton lines={5} />
          <CardSkeleton lines={5} />
        </div>
      </div>
    );
  }

  const { profile, conversations, messageCount, notifications, projects } = data;
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";
  const unread = notifications.filter((n) => !n.read).length;

  // Active chats per day for the last 14 days
  const msgsByDay = new Map<string, number>();
  conversations.forEach((c) => {
    const day = c.updated_at.slice(0, 10);
    msgsByDay.set(day, (msgsByDay.get(day) ?? 0) + 1);
  });
  const chartData = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400000);
    const key = d.toISOString().slice(0, 10);
    return { day: key.slice(5), chats: msgsByDay.get(key) ?? 0 };
  });

  const activity = [
    ...conversations.slice(0, 8).map((c) => ({
      id: `chat-${c.id}`,
      title: c.title,
      subtitle: "Conversation",
      timestamp: c.updated_at,
    })),
    ...notifications.slice(0, 4).map((n) => ({
      id: `notif-${n.id}`,
      title: n.title,
      subtitle: n.body ?? undefined,
      timestamp: n.created_at,
    })),
  ]
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
    .slice(0, 8);

  function startChat(e: React.FormEvent) {
    e.preventDefault();
    const q = prompt.trim();
    if (!q) return;
    const params = new URLSearchParams({ q });
    window.location.href = `/chats/new?${params.toString()}`;
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setProjectError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim() || "Untitled project",
          width: newWidth,
          height: newHeight,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create project");
      window.location.href = `/studio/${json.project.id}`;
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : "Failed to create project");
      setCreating(false);
    }
  }

  async function renameProject(p: ProjectSummary) {
    const next = window.prompt("Rename project", p.title)?.trim();
    if (!next || next === p.title) return;
    setProjectError(null);
    try {
      const res = await fetch(`/api/projects/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Rename failed");
      setData((d) =>
        d ? { ...d, projects: d.projects.map((q) => (q.id === p.id ? json.project : q)) } : d
      );
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : "Rename failed");
    }
  }

  async function deleteProject(p: ProjectSummary) {
    if (!window.confirm(`Delete "${p.title}"? This cannot be undone.`)) return;
    setDeletingId(p.id);
    setProjectError(null);
    try {
      const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "Delete failed");
      }
      setData((d) =>
        d ? { ...d, projects: d.projects.filter((q) => q.id !== p.id) } : d
      );
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Hi {firstName}</h1>
        <p className="text-sm text-slate-500 dark:text-neutral-400 mt-1">
          What would you like to work on today?
        </p>
        {guest && (
          <p className="mt-2 inline-block rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-xs font-medium px-3 py-1">
            Guest mode — sign up to save your data
          </p>
        )}
      </div>

      {/* Composer — ChatGPT-style prompt box */}
      <form
        onSubmit={startChat}
        className="rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#303030] shadow-sm p-3"
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask anything"
          className="w-full bg-transparent px-2 py-2 text-sm focus:outline-none placeholder:text-slate-400 dark:placeholder:text-neutral-500"
        />
        <div className="flex justify-end mt-1">
          <button
            type="submit"
            disabled={!prompt.trim()}
            className="rounded-full bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white p-2 transition"
            aria-label="Send"
          >
            <IconSend className="h-4 w-4" />
          </button>
        </div>
      </form>

      {/* Projects — drawing & animation studio */}
      <section className="rounded-2xl bg-white dark:bg-[#303030] border border-slate-200 dark:border-white/10 shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-sm">Projects</h2>
        </div>
        {guest ? (
          <EmptyState
            title="Sign in to create projects"
            message="Drawing and animation projects are saved to your account."
          />
        ) : (
          <>
            <form onSubmit={createProject} className="flex flex-wrap items-center gap-2 mb-4">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Project name"
                className="flex-1 min-w-36 rounded-lg border border-slate-200 dark:border-white/10 bg-transparent px-3 py-1.5 text-xs focus:border-teal-500 focus:outline-none"
              />
              <input
                type="number"
                min={8}
                max={8192}
                value={newWidth}
                onChange={(e) => setNewWidth(parseInt(e.target.value) || 0)}
                className="w-20 rounded-lg border border-slate-200 dark:border-white/10 bg-transparent px-3 py-1.5 text-xs focus:border-teal-500 focus:outline-none"
                aria-label="Canvas width"
              />
              <span className="text-xs text-slate-400">×</span>
              <input
                type="number"
                min={8}
                max={8192}
                value={newHeight}
                onChange={(e) => setNewHeight(parseInt(e.target.value) || 0)}
                className="w-20 rounded-lg border border-slate-200 dark:border-white/10 bg-transparent px-3 py-1.5 text-xs focus:border-teal-500 focus:outline-none"
                aria-label="Canvas height"
              />
              <button
                type="submit"
                disabled={creating}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white px-3 py-1.5 text-xs font-medium"
              >
                <IconPlus className="h-3.5 w-3.5" />
                {creating ? "Creating…" : "New project"}
              </button>
            </form>
            {projectError && (
              <p className="text-xs text-red-500 mb-3" role="alert">
                {projectError}
              </p>
            )}
            {projects.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-neutral-400 py-2">
                No projects yet. Create one to start drawing.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-white/10">
                {projects.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2.5 group">
                    <Link href={`/studio/${p.id}`} className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate group-hover:text-teal-600 dark:group-hover:text-teal-400">
                        {p.title}
                      </p>
                      <p className="text-xs text-slate-400">
                        {p.width} × {p.height} · {new Date(p.updated_at).toLocaleDateString()}
                      </p>
                    </Link>
                    <button
                      onClick={() => renameProject(p)}
                      className="rounded-lg px-2 py-1 text-xs text-slate-500 dark:text-neutral-400 hover:bg-slate-100 dark:hover:bg-white/10"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => deleteProject(p)}
                      disabled={deletingId === p.id}
                      className="rounded-lg p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40"
                      aria-label={`Delete ${p.title}`}
                    >
                      <IconTrash className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Conversations" value={String(conversations.length)} hint="All time" />
        <StatCard label="Messages" value={String(messageCount)} hint="Sent + received" />
        <StatCard label="Notifications" value={String(unread)} hint="Unread" />
        <StatCard label="This week" value={String(chartData.slice(-7).reduce((s, d) => s + d.chats, 0))} hint="Active chats" />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <section className="rounded-2xl bg-white dark:bg-[#303030] border border-slate-200 dark:border-white/10 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-sm">Recent chats</h2>
            <Link href="/chats" className="text-xs text-teal-600 dark:text-teal-400 hover:underline">
              View all
            </Link>
          </div>
          {conversations.length === 0 ? (
            <EmptyState
              title="No conversations yet"
              message="Start a chat and it will show up here."
              action={
                <Link
                  href="/chats/new"
                  className="inline-flex items-center gap-2 rounded-xl bg-teal-600 text-white px-4 py-2 text-sm font-medium"
                >
                  <IconPlus className="h-4 w-4" /> New chat
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-white/10">
              {conversations.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/chats/${c.id}`}
                    className="flex items-center gap-3 py-3 group"
                  >
                    <span className="rounded-lg bg-slate-100 dark:bg-white/10 p-2 text-slate-500 dark:text-neutral-400 group-hover:text-teal-600 dark:group-hover:text-teal-400 transition">
                      <IconChat className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{c.title}</p>
                      <p className="text-xs text-slate-400">
                        {new Date(c.updated_at).toLocaleDateString()}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl bg-white dark:bg-[#303030] border border-slate-200 dark:border-white/10 shadow-sm p-5">
          <h2 className="font-semibold text-sm mb-4">Activity — last 14 days</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="chats" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0d9488" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#0d9488" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#94a3b822" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid #e2e8f0",
                    fontSize: 12,
                  }}
                />
                <Area type="monotone" dataKey="chats" stroke="#0d9488" strokeWidth={2} fill="url(#chats)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section className="rounded-2xl bg-white dark:bg-[#303030] border border-slate-200 dark:border-white/10 shadow-sm p-5">
        <h2 className="font-semibold text-sm mb-2">Recent activity</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-neutral-400 py-4 text-center">
            No recent activity yet.
          </p>
        ) : (
          <ActivityList items={activity} />
        )}
      </section>
    </div>
  );
}

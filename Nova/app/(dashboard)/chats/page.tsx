"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { isGuestClient } from "@/lib/guest";
import type { Conversation } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
import { ListSkeleton } from "@/components/Skeletons";
import { IconChat, IconPlus, IconTrash } from "@/components/Icons";

export default function ChatsPage() {
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  async function load() {
    try {
      if (isGuestClient()) {
        setChats([]);
        return;
      }
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase
        .from("conversations")
        .select("*")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      setChats((data ?? []) as Conversation[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load chats.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    if (!chats) return [];
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats, query]);

  async function remove(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDeleting(id);
    try {
      const supabase = getSupabaseBrowser();
      const { error } = await supabase.from("conversations").delete().eq("id", id);
      if (error) throw error;
      setChats((prev) => (prev ?? []).filter((c) => c.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete chat.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Chats</h1>
          <p className="text-sm text-slate-500 dark:text-neutral-400">
            Your conversation history.
          </p>
        </div>
        <Link
          href="/chats/new"
          className="inline-flex items-center gap-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium px-4 py-2.5 transition"
        >
          <IconPlus className="h-4 w-4" /> New chat
        </Link>
      </div>

      {chats && chats.length > 3 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats…"
          className="w-full max-w-sm rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#303030] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
      )}

      {error && <EmptyState title="Couldn't load chats" message={error} />}
      {!error && chats === null && <ListSkeleton rows={5} />}
      {!error && chats !== null && visible.length === 0 && (
        <EmptyState
          title={query ? "No matches" : "No chats yet"}
          message={
            query
              ? "Try a different search term."
              : "Start a conversation and it will show up here."
          }
          action={
            <Link
              href="/chats/new"
              className="inline-flex items-center gap-2 rounded-xl bg-teal-600 text-white px-4 py-2 text-sm font-medium"
            >
              <IconPlus className="h-4 w-4" /> New chat
            </Link>
          }
        />
      )}

      {visible.length > 0 && (
        <ul className="space-y-2">
          {visible.map((chat) => (
            <li key={chat.id}>
              <Link
                href={`/chats/${chat.id}`}
                className="group flex items-center gap-3 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#303030] px-4 py-3 hover:border-teal-500/50 transition"
              >
                <span className="rounded-lg bg-slate-100 dark:bg-white/10 p-2 text-slate-500 dark:text-neutral-400">
                  <IconChat className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{chat.title}</p>
                  <p className="text-xs text-slate-400">
                    Updated {new Date(chat.updated_at).toLocaleString()}
                  </p>
                </div>
                <button
                  onClick={(e) => remove(chat.id, e)}
                  disabled={deleting === chat.id}
                  className="rounded-lg p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 opacity-0 group-hover:opacity-100 transition disabled:opacity-50"
                  aria-label={`Delete ${chat.title}`}
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { isGuestClient } from "@/lib/guest";
import type { Notification } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
import { ListSkeleton } from "@/components/Skeletons";

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  async function load() {
    try {
      if (isGuestClient()) {
        setItems([]);
        return;
      }
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setItems((data ?? []) as Notification[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notifications.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markAllRead() {
    if (!items) return;
    setMarking(true);
    try {
      if (isGuestClient()) return;
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const unreadIds = items.filter((n) => !n.read).map((n) => n.id);
      if (unreadIds.length === 0) return;
      const { error } = await supabase
        .from("notifications")
        .update({ read: true })
        .in("id", unreadIds);
      if (error) throw error;
      setItems(items.map((n) => ({ ...n, read: true })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update notifications.");
    } finally {
      setMarking(false);
    }
  }

  const unreadCount = items?.filter((n) => !n.read).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up"}
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            disabled={marking}
            className="rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60 transition"
          >
            {marking ? "Marking…" : "Mark all as read"}
          </button>
        )}
      </div>

      {error && <EmptyState title="Couldn't load notifications" message={error} />}
      {!error && items === null && <ListSkeleton rows={5} />}
      {!error && items !== null && items.length === 0 && (
        <EmptyState
          title="No notifications"
          message="Replies, reminders and product news will appear here."
        />
      )}

      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((n) => (
            <li
              key={n.id}
              className={`rounded-2xl border p-4 flex gap-3 ${
                n.read
                  ? "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800"
                  : "bg-teal-50/60 dark:bg-teal-900/20 border-teal-200 dark:border-teal-800"
              }`}
            >
              <span className="mt-0.5" aria-hidden>
                {n.read ? "⚪" : "🔵"}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{n.title}</p>
                {n.body && (
                  <p className="text-sm text-slate-600 dark:text-slate-300 mt-0.5">{n.body}</p>
                )}
                <p className="text-xs text-slate-400 mt-1">
                  {new Date(n.created_at).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

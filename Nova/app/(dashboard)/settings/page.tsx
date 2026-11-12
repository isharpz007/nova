"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { isGuestClient } from "@/lib/guest";
import { useTheme } from "@/components/ThemeProvider";
import type { NotificationPreferences } from "@/lib/types";
import { CardSkeleton } from "@/components/Skeletons";

const PREFS: { key: keyof NotificationPreferences; label: string; desc: string }[] = [
  { key: "email_updates", label: "Email — updates", desc: "Replies, mentions and account emails" },
  { key: "email_digest", label: "Email — weekly digest", desc: "A summary of your week in one email" },
  { key: "push_updates", label: "Push — updates", desc: "Browser notifications for new activity" },
  { key: "push_digest", label: "Push — digest", desc: "Browser notifications for weekly recap" },
];

const DEFAULT_PREFS: NotificationPreferences = {
  email_updates: true,
  email_digest: false,
  push_updates: true,
  push_digest: false,
};

export default function SettingsPage() {
  const { theme, toggle } = useTheme();
  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        if (isGuestClient()) return;
        const supabase = getSupabaseBrowser();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        const { data } = await supabase
          .from("profiles")
          .select("notification_prefs")
          .eq("id", user.id)
          .single<{ notification_prefs: NotificationPreferences | null }>();
        if (data?.notification_prefs) {
          setPrefs({ ...DEFAULT_PREFS, ...data.notification_prefs });
        }
      } catch {
        // Preferences are optional; fall back to defaults.
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function savePrefs(next: NotificationPreferences) {
    setPrefs(next);
    setSaving(true);
    setMessage(null);
    try {
      if (isGuestClient()) {
        setMessage("Guest mode — preferences aren't saved.");
        return;
      }
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const { error } = await supabase
        .from("profiles")
        .update({ notification_prefs: next })
        .eq("id", user.id);
      if (error) throw error;
      setMessage("Preferences saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save preferences.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Appearance and notification preferences.
        </p>
      </div>

      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm p-5">
        <h2 className="font-semibold mb-3">Appearance</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Dark mode</p>
            <p className="text-xs text-slate-500">Currently {theme}</p>
          </div>
          <button
            onClick={toggle}
            className="relative h-7 w-12 rounded-full bg-slate-300 dark:bg-teal-600 transition"
            aria-label="Toggle dark mode"
          >
            <span
              className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
                theme === "dark" ? "left-6" : "left-1"
              }`}
            />
          </button>
        </div>
      </section>

      <section className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm p-5">
        <h2 className="font-semibold mb-3">Notifications</h2>
        {loading ? (
          <CardSkeleton lines={4} />
        ) : (
          <div className="space-y-4">
            {PREFS.map((pref) => (
              <div key={pref.key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{pref.label}</p>
                  <p className="text-xs text-slate-500">{pref.desc}</p>
                </div>
                <button
                  onClick={() => savePrefs({ ...prefs, [pref.key]: !prefs[pref.key] })}
                  disabled={saving}
                  className={`relative h-7 w-12 rounded-full transition disabled:opacity-60 ${
                    prefs[pref.key] ? "bg-teal-600" : "bg-slate-300 dark:bg-slate-700"
                  }`}
                  aria-label={pref.label}
                >
                  <span
                    className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      prefs[pref.key] ? "left-6" : "left-1"
                    }`}
                  />
                </button>
              </div>
            ))}
            {message && (
              <p className="text-sm text-teal-700 dark:text-teal-300" role="status">
                {message}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

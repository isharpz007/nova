"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { isGuestClient } from "@/lib/guest";
import type { Profile } from "@/lib/types";
import { CardSkeleton } from "@/components/Skeletons";
import { SignOutButton } from "@/components/SignOutButton";

export default function ProfilePage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [pwMessage, setPwMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [guest, setGuest] = useState(false);

  useEffect(() => {
    setGuest(isGuestClient());
  }, []);

  useEffect(() => {
    async function load() {
      try {
        if (isGuestClient()) return;
        const supabase = getSupabaseBrowser();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        const { data, error } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .single<Profile>();
        if (error) throw error;
        setFullName(data.full_name ?? "");
        setPhone(data.phone ?? "");
        setAvatarUrl(data.avatar_url);
      } catch (err) {
        setMessage({
          kind: "err",
          text: err instanceof Error ? err.message : "Failed to load profile.",
        });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function uploadAvatar(file: File): Promise<string> {
    const supabase = getSupabaseBrowser();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not signed in.");
    const ext = file.name.split(".").pop() ?? "png";
    const path = `${user.id}/avatar.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("avatars")
      .upload(path, file, { upsert: true });
    if (upErr) throw upErr;
    const { data } = supabase.storage.from("avatars").getPublicUrl(path);
    setAvatarUrl(data.publicUrl);
    return data.publicUrl;
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (isGuestClient()) {
      setMessage({ kind: "err", text: "Guest mode — create an account to save your profile." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");

      let avatar = avatarUrl;
      const file = fileRef.current?.files?.[0];
      if (file) avatar = await uploadAvatar(file);

      const { error } = await supabase
        .from("profiles")
        .update({
          full_name: fullName.trim() || null,
          phone: phone.trim() || null,
          avatar_url: avatar,
        })
        .eq("id", user.id);
      if (error) throw error;
      setMessage({ kind: "ok", text: "Profile saved." });
      router.refresh();
    } catch (err) {
      setMessage({ kind: "err", text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMessage(null);
    if (isGuestClient()) {
      setPwMessage({ kind: "err", text: "Guest mode — create an account to set a password." });
      return;
    }
    if (newPassword.length < 6) {
      setPwMessage({ kind: "err", text: "Password must be at least 6 characters." });
      return;
    }
    try {
      const { error } = await getSupabaseBrowser().auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword("");
      setPwMessage({ kind: "ok", text: "Password updated." });
    } catch (err) {
      setPwMessage({ kind: "err", text: err instanceof Error ? err.message : "Update failed." });
    }
  }

  if (loading) {
    return (
      <div className="max-w-xl space-y-4">
        <CardSkeleton lines={5} />
        <CardSkeleton lines={3} />
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Manage your personal information.
        </p>
        {guest && (
          <p className="mt-2 inline-block rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-xs font-medium px-3 py-1">
            Guest mode — nothing here is saved
          </p>
        )}
      </div>

      <form
        onSubmit={saveProfile}
        className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4"
      >
        <div className="flex items-center gap-4">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt="Avatar"
              className="h-16 w-16 rounded-full object-cover"
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center text-2xl">
              👤
            </div>
          )}
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="text-sm"
              aria-label="Upload photo"
            />
            <p className="text-xs text-slate-400 mt-1">JPG or PNG. Saved to your profile.</p>
          </div>
        </div>

        <div>
          <label htmlFor="fullName" className="block text-sm font-medium mb-1">
            Full name
          </label>
          <input
            id="fullName"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>
        <div>
          <label htmlFor="phone" className="block text-sm font-medium mb-1">
            Phone number
          </label>
          <input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500"
            placeholder="+1 555 000 0000"
          />
        </div>

        {message && (
          <p
            className={`text-sm ${message.kind === "ok" ? "text-teal-700 dark:text-teal-300" : "text-red-600 dark:text-red-400"}`}
            role="status"
          >
            {message.text}
          </p>
        )}
        <button
          type="submit"
          disabled={saving}
          className="rounded-xl bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white font-medium px-5 py-2.5 transition"
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
      </form>

      <form
        onSubmit={changePassword}
        className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4"
      >
        <h2 className="font-semibold">Change password</h2>
        <input
          type="password"
          required
          minLength={6}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password (min 6 chars)"
          className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        {pwMessage && (
          <p
            className={`text-sm ${pwMessage.kind === "ok" ? "text-teal-700 dark:text-teal-300" : "text-red-600 dark:text-red-400"}`}
            role="status"
          >
            {pwMessage.text}
          </p>
        )}
        <button
          type="submit"
          className="rounded-xl border border-slate-300 dark:border-slate-700 px-5 py-2.5 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800 transition"
        >
          Update password
        </button>
      </form>

      <SignOutButton />
    </div>
  );
}

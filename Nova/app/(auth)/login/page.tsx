"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { setGuestCookie, clearGuestCookie } from "@/lib/guest";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { error } = await getSupabaseBrowser().auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      clearGuestCookie();
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium mb-1">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500"
          placeholder="••••••••"
        />
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white font-medium py-2.5 transition"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="text-teal-600 dark:text-teal-400 hover:underline">
          Forgot password?
        </Link>
        <Link href="/signup" className="text-teal-600 dark:text-teal-400 hover:underline">
          Create account
        </Link>
      </div>
      <button
        type="button"
        onClick={() => {
          setGuestCookie();
          router.push("/");
          router.refresh();
        }}
        className="w-full rounded-xl border border-slate-300 dark:border-slate-700 text-sm font-medium py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
      >
        Continue as guest
      </button>
      <p className="text-xs text-center text-slate-400">
        Guest mode is read-only — sign up to save your data.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 shadow-lg border border-slate-200 dark:border-slate-800 p-8">
        <h1 className="text-2xl font-bold mb-1">Welcome back</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          Sign in to your Nova account
        </p>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}

# Nova AI Assistant Dashboard

A ChatGPT-style personal assistant dashboard built with Next.js (App Router),
TypeScript, Tailwind CSS, Supabase (auth + Postgres + RLS), and Recharts.

## Features

- **Auth** — sign up, log in, log out, forgot/reset password (Supabase Auth).
  Logged-out users are redirected to `/login` by `middleware.ts`.
- **Guest mode** — "Continue as guest" on the login page browses the app with
  empty data; nothing is saved until you create an account.
- **Home** — ChatGPT-style composer ("Ask anything"), stat cards, recent chats,
  activity chart, activity feed.
- **Chats** — conversation list with search and delete, full message thread
  view, new-chat composer. Messages persist per user via RLS.
- **Profile** — edit name, phone, avatar photo; change password.
- **Notifications** — read/unread state, mark all as read.
- **Settings** — light/dark mode, notification preferences.
- **Design** — dark sidebar with recent-chat history (ChatGPT look), bottom
  nav on mobile, skeletons and empty states throughout.
- **Security** — RLS on every table: users only see their own rows.

## Setup

1. Create a Supabase project at https://supabase.com.
2. In the SQL editor, run `supabase/schema.sql`, then `supabase/seed.sql`
   (after creating a test auth user — see comments in the file).
3. Copy env vars:

   ```bash
   cp .env.example .env.local
   ```

   Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   from Project Settings → API.

4. Install and run:

   ```bash
   npm install
   npm run dev
   ```

   Open http://localhost:3000.

## Scripts

| Command         | Purpose              |
| --------------- | -------------------- |
| `npm run dev`   | Dev server           |
| `npm run build` | Production build     |
| `npm start`     | Serve production build |

## Structure

```
app/(auth)/          login, signup, forgot-password, update-password
app/(dashboard)/     layout + home, chats, notifications, profile, settings
components/          ChatThread, Sidebar, BottomNav, StatCard, skeletons, icons
lib/supabase/        browser + server Supabase clients
lib/reply.ts         placeholder assistant replies (swap for a real model)
supabase/            schema.sql (RLS), seed.sql
middleware.ts        auth redirect + session refresh
```

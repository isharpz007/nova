-- Seed data for a test user. Create the auth user first (Supabase dashboard
-- or sign up through the app), then replace the uuid below with:
--   select id from auth.users where email = 'you@example.com';

do $$
declare
  uid uuid := '00000000-0000-0000-0000-000000000001';
  c1 uuid := '11111111-1111-1111-1111-111111111111';
  c2 uuid := '22222222-2222-2222-2222-222222222222';
begin
  if not exists (select 1 from auth.users where id = uid) then
    raise notice 'Seed user % not found — create it first, then re-run.', uid;
    return;
  end if;

  insert into public.profiles (id, full_name)
  values (uid, 'Alex Rivera')
  on conflict (id) do nothing;

  insert into public.conversations (id, user_id, title, created_at, updated_at)
  values
    (c1, uid, 'Weekly meal prep ideas', now() - interval '5 hours', now() - interval '1 hour'),
    (c2, uid, 'Explain quantum computing simply', now() - interval '2 days', now() - interval '2 days')
  on conflict (id) do nothing;

  insert into public.messages (conversation_id, user_id, role, content, created_at)
  values
    (c1, uid, 'user', 'Give me 5 healthy lunch ideas I can prep on Sunday.', now() - interval '5 hours'),
    (c1, uid, 'assistant', 'Here are five make-ahead lunches: quinoa bowls, turkey wraps, lentil soup, yogurt parfaits, and chicken burrito bowls. Want full recipes?', now() - interval '4 hours'),
    (c2, uid, 'user', 'Explain quantum computing like I''m 10.', now() - interval '2 days'),
    (c2, uid, 'assistant', 'A quantum computer uses bits that can be 0 and 1 at the same time, so it can try many answers at once.', now() - interval '2 days')
  on conflict do nothing;

  insert into public.notifications (user_id, title, body, read, created_at)
  values
    (uid, 'New feature: voice mode', 'You can now talk to your assistant hands-free.', false, now() - interval '3 hours'),
    (uid, 'Weekly summary ready', 'You had 4 conversations this week — here''s your recap.', false, now() - interval '1 day'),
    (uid, 'Welcome to Nova', 'Thanks for signing up! Start your first chat.', true, now() - interval '3 days');
end $$;

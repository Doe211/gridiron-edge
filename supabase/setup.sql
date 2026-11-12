-- Gridiron Edge database: players' picks, the pick deadline, and adjusted lines.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Change the admin email at the bottom before running.

-- Who counts as the administrator (can see every pick and change lines and the deadline).
create table if not exists public.admins (
  email text primary key
);

-- Settings everyone can read, like the pick deadline: key 'picks_close', value '"2026-11-15T18:00:00Z"'.
create table if not exists public.settings (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);

-- Lines set by the administrator. spread = points the HOME team is favored by.
create table if not exists public.lines (
  game_id text primary key,
  spread numeric,
  total numeric,
  updated_at timestamptz not null default now()
);

-- One row per player, per game, per kind of pick.
create table if not exists public.picks (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  league text not null,
  game_id text not null,
  matchup text,                                     -- e.g. "WAS at NYG", for the admin page
  kind text not null check (kind in ('side', 'total')),
  choice text not null check (choice in ('home', 'away', 'over', 'under')),
  line numeric,                                     -- the spread or total when the pick was made
  kickoff timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id, kind)
);
create index if not exists picks_game on public.picks (game_id);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

-- Picks are open until the game starts and until the administrator's deadline, if one is set.
create or replace function public.picks_open(kick timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select now() < kick
     and coalesce(now() < (select (value #>> '{}')::timestamptz from public.settings where key = 'picks_close'), true);
$$;

alter table public.admins enable row level security;
alter table public.settings enable row level security;
alter table public.lines enable row level security;
alter table public.picks enable row level security;

drop policy if exists "admins: admin reads" on public.admins;
create policy "admins: admin reads" on public.admins for select using (public.is_admin());

drop policy if exists "settings: anyone reads" on public.settings;
create policy "settings: anyone reads" on public.settings for select using (true);
drop policy if exists "settings: admin writes" on public.settings;
create policy "settings: admin writes" on public.settings for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "lines: anyone reads" on public.lines;
create policy "lines: anyone reads" on public.lines for select using (true);
drop policy if exists "lines: admin writes" on public.lines;
create policy "lines: admin writes" on public.lines for all using (public.is_admin()) with check (public.is_admin());

-- Players see and change only their own picks, and only while picks are open. The admin sees all.
drop policy if exists "picks: own or admin reads" on public.picks;
create policy "picks: own or admin reads" on public.picks for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "picks: add own while open" on public.picks;
create policy "picks: add own while open" on public.picks for insert with check (user_id = auth.uid() and public.picks_open(kickoff));
drop policy if exists "picks: change own while open" on public.picks;
create policy "picks: change own while open" on public.picks for update
  using (user_id = auth.uid() and public.picks_open(kickoff)) with check (user_id = auth.uid() and public.picks_open(kickoff));
drop policy if exists "picks: remove own while open" on public.picks;
create policy "picks: remove own while open" on public.picks for delete using (user_id = auth.uid() and public.picks_open(kickoff));

-- A player's name change applies to all their picks.
create or replace function public.rename_me(new_name text) returns void
language sql security definer set search_path = public as $$
  update public.picks set name = new_name where user_id = auth.uid();
$$;

grant select on public.settings, public.lines to anon, authenticated;
grant select, insert, update, delete on public.picks to authenticated;
grant insert, update, delete on public.settings, public.lines to authenticated;
grant select on public.admins to authenticated;
grant execute on function public.rename_me(text) to authenticated;

-- The administrator's email (the one you'll sign in with on the site).
insert into public.admins (email) values ('CHANGE-ME@example.com') on conflict do nothing;
insert into public.settings (key, value) values ('picks_close', '"2026-11-12T22:00:00.000Z"') on conflict do nothing;

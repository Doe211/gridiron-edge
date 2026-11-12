-- Gives every player a permanent player number (#1001, #1002, ...) so two players
-- with the same name can be told apart. Run once in Supabase's SQL Editor after setup.sql.

create table if not exists public.players (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  number bigint generated always as identity (start with 1001) unique,
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);

alter table public.players enable row level security;

drop policy if exists "players: own or admin reads" on public.players;
create policy "players: own or admin reads" on public.players for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "players: add self" on public.players;
create policy "players: add self" on public.players for insert with check (user_id = auth.uid());
drop policy if exists "players: rename self" on public.players;
create policy "players: rename self" on public.players for update using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update on public.players to authenticated;

-- A player's name change applies to their player entry and all their picks.
create or replace function public.rename_me(new_name text) returns void
language sql security definer set search_path = public as $$
  update public.players set name = new_name where user_id = auth.uid();
  update public.picks set name = new_name where user_id = auth.uid();
$$;

-- Players who already made picks get a number now.
insert into public.players (user_id, name)
select distinct on (user_id) user_id, name from public.picks order by user_id, updated_at desc
on conflict (user_id) do nothing;

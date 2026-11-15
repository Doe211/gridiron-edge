-- Lines are the administrator's, not Vegas's.
--   lines            the administrator's working lines (drafts). Only the administrator can see them.
--   published_lines  what players see and pick against. Filled only by publish_lines().
-- A game with no published line has no line for players, and can't be picked.

create table if not exists public.published_lines (
  game_id      text primary key,
  spread       numeric,
  total        numeric,
  published_at timestamptz not null default now()
);
alter table public.published_lines enable row level security;
drop policy if exists "published lines: anyone reads" on public.published_lines;
create policy "published lines: anyone reads" on public.published_lines for select using (true);
grant select on public.published_lines to anon, authenticated;

-- Drafts are private to the administrator now.
drop policy if exists "lines: anyone reads" on public.lines;
drop policy if exists "lines: admin reads" on public.lines;
create policy "lines: admin reads" on public.lines for select using (public.is_admin());

-- Makes the published lines exactly match the administrator's working lines.
create or replace function public.publish_lines() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'Only the administrator can publish lines'; end if;
  delete from published_lines where true;
  insert into published_lines (game_id, spread, total, published_at)
  select game_id, spread, total, now() from lines where spread is not null or total is not null;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.publish_lines() from public;
grant execute on function public.publish_lines() to authenticated;

-- Tickets use only published lines (no Vegas fallback).
create or replace function public.place_ticket(p_name text, p_league text, p_wager int, p_picks jsonb)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  n int := jsonb_array_length(coalesce(p_picks, '[]'::jsonb));
  deadline timestamptz := (select (value #>> '{}')::timestamptz from settings where key = 'picks_close');
  t_number bigint;
  leg jsonb;
  g games%rowtype;
  pub published_lines%rowtype;
  leg_line numeric;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter a name for your ticket'; end if;
  if n < 3 or n > 12 then raise exception 'A ticket needs 3 to 12 picks'; end if;
  if p_wager is null or p_wager < 1 or p_wager > 100 then raise exception 'Wager 1 to 100'; end if;
  if deadline is not null and now() >= deadline then raise exception 'Picks are closed'; end if;

  insert into tickets (user_id, name, league, wager, legs)
  values (auth.uid(), left(trim(p_name), 40), p_league, p_wager, n)
  returning number into t_number;

  for leg in select * from jsonb_array_elements(p_picks) loop
    select * into g from games where id = leg->>'game_id' and league = p_league;
    if not found then raise exception 'Unknown game %', leg->>'game_id'; end if;
    if g.kickoff is null or now() >= g.kickoff then raise exception '% at % has already started', g.away, g.home; end if;
    pub := null;
    select * into pub from published_lines where game_id = g.id;
    if leg->>'kind' = 'side' then
      if leg->>'choice' not in ('home', 'away') then raise exception 'Bad pick'; end if;
      leg_line := pub.spread;
    elsif leg->>'kind' = 'total' then
      if leg->>'choice' not in ('over', 'under') then raise exception 'Bad pick'; end if;
      leg_line := pub.total;
    else
      raise exception 'Bad pick';
    end if;
    if leg_line is null then raise exception '% at % has no line yet', g.away, g.home; end if;
    insert into ticket_picks (ticket_number, game_id, matchup, kind, choice, line, kickoff)
    values (t_number, g.id, g.away || ' at ' || g.home, leg->>'kind', leg->>'choice', leg_line, g.kickoff);
  end loop;
  return t_number;
end;
$$;

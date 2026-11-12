-- Tickets: a 3- to 8-pick parlay with a wager in coins. Once placed, a ticket can never be changed.
-- Run once in Supabase's SQL Editor (after setup.sql and players.sql).

-- The schedule and Vegas lines, kept up to date by the website's scheduled job (with the secret key).
-- The database uses it to check every ticket: games not started yet, and the real current line.
create table if not exists public.games (
  id text primary key,
  league text not null,
  kickoff timestamptz,
  home text not null,
  away text not null,
  spread numeric,          -- points the HOME team is favored by
  total numeric,
  home_score int,
  away_score int,
  updated_at timestamptz not null default now()
);
create index if not exists games_league_kickoff on public.games (league, kickoff);

create table if not exists public.tickets (
  number bigint generated always as identity (start with 1001) primary key,
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  name text not null check (char_length(name) between 1 and 40),
  league text not null,
  wager int not null check (wager between 1 and 100),
  legs int not null check (legs between 3 and 8),
  placed_at timestamptz not null default now()
);
create index if not exists tickets_user on public.tickets (user_id);

create table if not exists public.ticket_picks (
  ticket_number bigint not null references public.tickets (number) on delete cascade,
  game_id text not null,
  matchup text,
  kind text not null check (kind in ('side', 'total')),
  choice text not null check (choice in ('home', 'away', 'over', 'under')),
  line numeric not null,      -- the line at the moment the ticket was placed
  kickoff timestamptz not null,
  primary key (ticket_number, game_id, kind)
);
create index if not exists ticket_picks_game on public.ticket_picks (game_id);

alter table public.games enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_picks enable row level security;

drop policy if exists "games: anyone reads" on public.games;
create policy "games: anyone reads" on public.games for select using (true);

-- Players see only their own tickets; the administrator sees all. Nobody can change a placed
-- ticket (there are no insert/update rules). The administrator can void (delete) a ticket.
drop policy if exists "tickets: own or admin reads" on public.tickets;
create policy "tickets: own or admin reads" on public.tickets for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "tickets: admin voids" on public.tickets;
create policy "tickets: admin voids" on public.tickets for delete using (public.is_admin());

drop policy if exists "ticket picks: own or admin reads" on public.ticket_picks;
create policy "ticket picks: own or admin reads" on public.ticket_picks for select using (
  exists (select 1 from public.tickets t where t.number = ticket_number and (t.user_id = auth.uid() or public.is_admin()))
);

grant select on public.games to anon, authenticated;
grant select on public.tickets, public.ticket_picks to authenticated;
grant delete on public.tickets to authenticated;

-- Places a ticket. picks is a list like [{"game_id": "...", "kind": "side", "choice": "home"}].
-- Checks everything here, in the database: 3-8 picks, every game still open, the deadline,
-- and records the real current line (an adjusted line if the administrator set one).
create or replace function public.place_ticket(p_name text, p_league text, p_wager int, p_picks jsonb)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  n int := jsonb_array_length(coalesce(p_picks, '[]'::jsonb));
  deadline timestamptz := (select (value #>> '{}')::timestamptz from settings where key = 'picks_close');
  t_number bigint;
  leg jsonb;
  g games%rowtype;
  adj lines%rowtype;
  leg_line numeric;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter a name for your ticket'; end if;
  if n < 3 or n > 8 then raise exception 'A ticket needs 3 to 8 picks'; end if;
  if p_wager is null or p_wager < 1 or p_wager > 100 then raise exception 'Wager 1 to 100'; end if;
  if deadline is not null and now() >= deadline then raise exception 'Picks are closed'; end if;

  insert into tickets (user_id, name, league, wager, legs)
  values (auth.uid(), left(trim(p_name), 40), p_league, p_wager, n)
  returning number into t_number;

  for leg in select * from jsonb_array_elements(p_picks) loop
    select * into g from games where id = leg->>'game_id' and league = p_league;
    if not found then raise exception 'Unknown game %', leg->>'game_id'; end if;
    if g.kickoff is null or now() >= g.kickoff then raise exception '% at % has already started', g.away, g.home; end if;
    select * into adj from lines where game_id = g.id;
    if leg->>'kind' = 'side' then
      if leg->>'choice' not in ('home', 'away') then raise exception 'Bad pick'; end if;
      leg_line := coalesce(adj.spread, g.spread);
    elsif leg->>'kind' = 'total' then
      if leg->>'choice' not in ('over', 'under') then raise exception 'Bad pick'; end if;
      leg_line := coalesce(adj.total, g.total);
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

revoke all on function public.place_ticket(text, text, int, jsonb) from public, anon;
grant execute on function public.place_ticket(text, text, int, jsonb) to authenticated;

-- Allow tickets of 3 to 12 picks (new payout chart). Run once in Supabase's SQL Editor.
alter table public.tickets drop constraint if exists tickets_legs_check;
alter table public.tickets add constraint tickets_legs_check check (legs between 3 and 12);

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

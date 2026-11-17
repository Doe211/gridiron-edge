-- Certifying tickets. A ticket must be certified by the administrator at least one hour before
-- its first game starts, or it is voided (deleted) automatically.
-- Run once in Supabase's SQL Editor (after tickets.sql and tickets_12.sql).

alter table public.tickets add column if not exists certified_at timestamptz;
-- Tickets placed before this rule existed count as certified, so they are never voided by it.
update public.tickets set certified_at = placed_at where certified_at is null;

-- When a ticket must be certified by: one hour before its first game.
create or replace function public.ticket_certify_by(p_number bigint) returns timestamptz
language sql stable security definer set search_path = public as $$
  select min(kickoff) - interval '1 hour' from ticket_picks where ticket_number = p_number;
$$;
grant execute on function public.ticket_certify_by(bigint) to anon, authenticated;

-- Administrator: certify a ticket, or with p_certified = false take the certification back.
create or replace function public.certify_ticket(p_number bigint, p_certified boolean default true) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare by_time timestamptz := public.ticket_certify_by(p_number); result timestamptz;
begin
  if not public.is_admin() then raise exception 'Only the administrator can certify tickets'; end if;
  if p_certified and by_time is not null and now() >= by_time then
    raise exception 'Too late: tickets must be certified an hour before the first game starts';
  end if;
  update tickets set certified_at = case when p_certified then now() else null end
  where number = p_number returning certified_at into result;
  if not found then raise exception 'Ticket % not found', p_number; end if;
  return result;
end;
$$;
revoke all on function public.certify_ticket(bigint, boolean) from public;
grant execute on function public.certify_ticket(bigint, boolean) to authenticated;

-- Voids every ticket that wasn't certified by one hour before its first game. Runs every minute.
create or replace function public.void_uncertified_tickets() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from tickets t
  where t.certified_at is null
    and now() >= (select min(p.kickoff) - interval '1 hour' from ticket_picks p where p.ticket_number = t.number);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.void_uncertified_tickets() from public, anon, authenticated;

select cron.unschedule('gridiron-void-uncertified') where exists (select 1 from cron.job where jobname = 'gridiron-void-uncertified');
select cron.schedule('gridiron-void-uncertified', '* * * * *', 'select public.void_uncertified_tickets()');

-- New tickets can't include a game starting within the hour, since there'd be no time to certify them.
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
    if now() >= g.kickoff - interval '1 hour' then
      raise exception '% at % starts within the hour. Tickets must be certified an hour before the first game, so remove that pick.', g.away, g.home;
    end if;
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

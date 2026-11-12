-- The database keeps its own copy of the schedule and Vegas lines by downloading the website's
-- public data files every 30 minutes. No secret key needed. Tickets are checked against it.
-- Run once in Supabase's SQL Editor (after tickets.sql).

create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.games_sync (
  request_id bigint primary key,
  league text not null,
  requested_at timestamptz not null default now()
);
alter table public.games_sync enable row level security;

create or replace function public.sync_games() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  req record;
  resp record;
  doc jsonb;
  cur int;
  lg text;
begin
  -- 1. Store the downloads that have arrived since last time.
  for req in select * from games_sync loop
    select * into resp from net._http_response where id = req.request_id;
    if not found then
      if req.requested_at < now() - interval '1 hour' then delete from games_sync where request_id = req.request_id; end if;
      continue;
    end if;
    if resp.status_code = 200 then
      begin
        doc := resp.content::jsonb;
        cur := (doc->>'current_season')::int;
        insert into games (id, league, kickoff, home, away, spread, total, home_score, away_score, updated_at)
        select g->>'id', req.league, (g->>'kickoff')::timestamptz, g->>'home', g->>'away',
               (g->>'spread')::numeric, (g->>'total')::numeric,
               (g->>'home_score')::int, (g->>'away_score')::int, now()
        from jsonb_array_elements(doc->'games') as g
        where (g->>'season')::int = cur
          and g->>'kickoff' is not null
          and (g->>'kickoff')::timestamptz between now() - interval '14 days' and now() + interval '45 days'
        on conflict (id) do update set
          kickoff = excluded.kickoff, home = excluded.home, away = excluded.away,
          spread = excluded.spread, total = excluded.total,
          home_score = excluded.home_score, away_score = excluded.away_score, updated_at = now();
      exception when others then
        raise warning 'Gridiron Edge: could not read % schedule: %', req.league, sqlerrm;
      end;
    end if;
    delete from games_sync where request_id = req.request_id;
  end loop;

  -- 2. Ask for fresh copies (they arrive in the background for next time).
  foreach lg in array array['nfl', 'college', 'nba', 'mlb'] loop
    insert into games_sync (request_id, league)
    values (net.http_get('https://doe211.github.io/gridiron-edge/data/' || lg || '.json?t=' || extract(epoch from now())::bigint,
                         timeout_milliseconds := 30000), lg);
  end loop;
end;
$$;

revoke all on function public.sync_games() from public, anon, authenticated;

-- Every 30 minutes.
select cron.unschedule(jobid) from cron.job where jobname = 'gridiron-sync-games';
select cron.schedule('gridiron-sync-games', '*/30 * * * *', 'select public.sync_games()');

-- Start right away.
select public.sync_games();

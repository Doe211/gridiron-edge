-- Quarter-by-quarter scores for Football Squares boards. Every minute, while a board's game is on,
-- the database asks ESPN's public scoreboard for the score and saves it on the board, so the website
-- and the app both read the same scores. No key needed.

alter table public.boards add column if not exists scores jsonb;

create table if not exists public.boards_sync (
  request_id   bigint primary key,
  board_id     bigint not null,
  requested_at timestamptz not null default now()
);
alter table public.boards_sync enable row level security;

-- Whether an ESPN competitor is the named team (by full name, school, nickname or abbreviation).
create or replace function public.espn_team_is(c jsonb, team text) returns boolean
language sql immutable as $$
  select exists (
    select 1 from unnest(array[c->'team'->>'displayName', c->'team'->>'location', c->'team'->>'shortDisplayName',
                               c->'team'->>'abbreviation', c->'team'->>'name']) x
    where x is not null and lower(regexp_replace(x, '[^A-Za-z0-9]', '', 'g')) = lower(regexp_replace(team, '[^A-Za-z0-9]', '', 'g')));
$$;

create or replace function public.sync_board_scores() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  req record; resp record; b boards%rowtype;
  doc jsonb; ev jsonb; comp jsonb; st jsonb; c1 jsonb; c2 jsonb; qs jsonb;
  period int; fin boolean; brk boolean; done boolean; q int; s1 int; s2 int;
  path text;
begin
  -- 1. Save the scoreboards that have arrived.
  for req in select * from boards_sync loop
    select * into resp from net._http_response where id = req.request_id;
    if not found then
      if req.requested_at < now() - interval '10 minutes' then delete from boards_sync where request_id = req.request_id; end if;
      continue;
    end if;
    if resp.status_code = 200 then
      begin
        select * into b from boards where id = req.board_id;
        if found then
          doc := resp.content::jsonb;
          select e into ev from jsonb_array_elements(doc->'events') e
          where (b.game_id like 'cfb\_%' and e->>'id' = substr(b.game_id, 5))
             or (exists (select 1 from jsonb_array_elements(e->'competitions'->0->'competitors') c where espn_team_is(c, b.team1))
                 and exists (select 1 from jsonb_array_elements(e->'competitions'->0->'competitors') c where espn_team_is(c, b.team2)))
          limit 1;
          if ev is not null then
            comp := ev->'competitions'->0;
            c1 := (select c from jsonb_array_elements(comp->'competitors') c where espn_team_is(c, b.team1) limit 1);
            if c1 is null then c1 := (select c from jsonb_array_elements(comp->'competitors') c where c->>'homeAway' = 'home' limit 1); end if;
            c2 := (select c from jsonb_array_elements(comp->'competitors') c where c <> c1 limit 1);
            st := coalesce(comp->'status', ev->'status');
            period := coalesce((st->>'period')::int, 0);
            fin := coalesce((st->'type'->>'completed')::boolean, false);
            brk := coalesce(st->'type'->>'name', '') ~ 'END_PERIOD|HALFTIME';
            qs := '[]'::jsonb;
            for q in 0..3 loop
              -- No overtime payouts: Final is the score at the end of the 4th quarter.
              done := fin or period > q + 1 or (period = q + 1 and brk);
              if not done then qs := qs || jsonb_build_array(null); continue; end if;
              s1 := (select coalesce(sum((l->>'value')::numeric), 0)::int from jsonb_array_elements(c1->'linescores') with ordinality t(l, n) where n <= q + 1);
              s2 := (select coalesce(sum((l->>'value')::numeric), 0)::int from jsonb_array_elements(c2->'linescores') with ordinality t(l, n) where n <= q + 1);
              qs := qs || jsonb_build_array(jsonb_build_array(s1, s2));
            end loop;
            update boards set scores = jsonb_build_object(
              'quarters', qs, 'final', fin, 'live', period > 0 and not fin,
              'now', jsonb_build_array(coalesce((c1->>'score')::numeric::int, 0), coalesce((c2->>'score')::numeric::int, 0)),
              'clock', st->'type'->>'shortDetail', 'updated', now())
            where id = b.id;
          end if;
        end if;
      exception when others then
        raise warning 'Gridiron Edge: could not read scores for board %: %', req.board_id, sqlerrm;
      end;
    end if;
    delete from boards_sync where request_id = req.request_id;
  end loop;

  -- 2. Ask for fresh scores for every board whose game is on (they arrive for the next run).
  for b in select * from boards
           where kickoff <= now() + interval '5 minutes' and kickoff > now() - interval '3 days'
             and coalesce((scores->>'final')::boolean, false) = false loop
    path := case b.league when 'nfl' then 'football/nfl' when 'college' then 'football/college-football' else 'basketball/nba' end;
    insert into boards_sync (request_id, board_id)
    values (net.http_get('https://site.api.espn.com/apis/site/v2/sports/' || path || '/scoreboard?dates='
                         || to_char(b.kickoff at time zone 'America/New_York', 'YYYYMMDD')
                         || case when b.league = 'college' then '&groups=80&limit=400' else '' end,
                         timeout_milliseconds := 20000), b.id);
  end loop;
end;
$$;

revoke all on function public.sync_board_scores() from public, anon, authenticated;

-- Every minute.
select cron.unschedule(jobid) from cron.job where jobname = 'gridiron-board-scores';
select cron.schedule('gridiron-board-scores', '* * * * *', 'select public.sync_board_scores()');

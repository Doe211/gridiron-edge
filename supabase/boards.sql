-- Football Squares boards. Everyone can see boards and who took each square.
-- Only the administrator creates, edits, or deletes boards and clears squares.
-- Players claim squares through claim_square(), which checks the board is still open.

create table if not exists public.boards (
  id          bigint generated always as identity (start with 1) primary key,
  title       text not null check (length(trim(title)) between 1 and 60),
  league      text not null check (league in ('nfl', 'college', 'nba')),
  game_id     text not null,
  kickoff     timestamptz,
  team1       text not null,              -- across the top (home team)
  team2       text not null,              -- down the side (away team)
  price       int  not null default 1 check (price between 0 and 100),   -- 🪙 per square
  prizes      int[] check (prizes is null or cardinality(prizes) = 4),   -- Q1, Q2, Q3, Final; null = split the pot
  top_digits  int[],                      -- 0-9 shuffled, column order (team1)
  side_digits int[],                      -- 0-9 shuffled, row order (team2)
  created_at  timestamptz not null default now()
);

create table if not exists public.board_squares (
  board_id   bigint not null references public.boards(id) on delete cascade,
  square     int not null check (square between 0 and 99),   -- 0 = top-left, row by row
  name       text not null check (length(trim(name)) between 1 and 40),
  user_id    uuid not null,
  created_at timestamptz not null default now(),
  primary key (board_id, square)
);

alter table public.boards enable row level security;
alter table public.board_squares enable row level security;

drop policy if exists "boards: anyone reads" on public.boards;
create policy "boards: anyone reads" on public.boards for select using (true);
drop policy if exists "boards: admin writes" on public.boards;
create policy "boards: admin writes" on public.boards for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "squares: anyone reads" on public.board_squares;
create policy "squares: anyone reads" on public.board_squares for select using (true);
drop policy if exists "squares: admin clears" on public.board_squares;
create policy "squares: admin clears" on public.board_squares for delete using (public.is_admin());

-- A player takes one open square.
create or replace function public.claim_square(p_board bigint, p_square int, p_name text)
returns void
language plpgsql security definer set search_path = public as $$
declare b boards%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter your name'; end if;
  if p_square is null or p_square < 0 or p_square > 99 then raise exception 'Bad square'; end if;
  select * into b from boards where id = p_board for update;
  if not found then raise exception 'That board no longer exists'; end if;
  if b.top_digits is not null then raise exception 'The numbers have been drawn, so this board is closed'; end if;
  if b.kickoff is not null and now() >= b.kickoff then raise exception 'The game has started, so this board is closed'; end if;
  insert into board_squares (board_id, square, name, user_id)
  values (p_board, p_square, left(trim(p_name), 40), auth.uid());
exception when unique_violation then
  raise exception 'Someone already took that square';
end;
$$;

-- The administrator draws the numbers once. After that, the board is locked.
create or replace function public.draw_numbers(p_board bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the administrator can draw numbers'; end if;
  update boards set
    top_digits  = (select array_agg(d order by random()) from generate_series(0, 9) d),
    side_digits = (select array_agg(d order by random()) from generate_series(0, 9) d)
  where id = p_board and top_digits is null;
  if not found then raise exception 'The numbers were already drawn'; end if;
end;
$$;

revoke all on function public.claim_square(bigint, int, text) from public;
grant execute on function public.claim_square(bigint, int, text) to authenticated;
revoke all on function public.draw_numbers(bigint) from public;
grant execute on function public.draw_numbers(bigint) to authenticated;

-- This project doesn't expose new tables automatically, so grant access (row level security still applies).
grant select on public.boards, public.board_squares to anon, authenticated;
grant insert, update, delete on public.boards to authenticated;
grant delete on public.board_squares to authenticated;

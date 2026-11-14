-- Each square shows the player's permanent number (#1001, #1002, ...) next to their name, so two
-- players with the same name can be told apart. The number belongs to the device's sign-in.

alter table public.board_squares add column if not exists player_no bigint;

-- Now returns the player's number.
drop function if exists public.claim_square(bigint, int, text);
create function public.claim_square(p_board bigint, p_square int, p_name text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare b boards%rowtype; n bigint;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter your name'; end if;
  if p_square is null or p_square < 0 or p_square > 99 then raise exception 'Bad square'; end if;
  select * into b from boards where id = p_board for update;
  if not found then raise exception 'That board no longer exists'; end if;
  if b.top_digits is not null then raise exception 'The numbers have been drawn, so this board is closed'; end if;
  if b.kickoff is not null and now() >= b.kickoff then raise exception 'The game has started, so this board is closed'; end if;
  insert into players (user_id, name) values (auth.uid(), left(trim(p_name), 40)) on conflict (user_id) do nothing;
  select number into n from players where user_id = auth.uid();
  insert into board_squares (board_id, square, name, user_id, player_no)
  values (p_board, p_square, left(trim(p_name), 40), auth.uid(), n);
  return n;
exception when unique_violation then
  raise exception 'Someone already took that square';
end;
$$;

revoke all on function public.claim_square(bigint, int, text) from public;
grant execute on function public.claim_square(bigint, int, text) to authenticated;

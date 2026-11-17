-- Invite only. Each person gets a personal link (…/#invite=CODE). The first device that opens it
-- claims it, and from then on only that device (and the administrator) can see or use the game.
-- Run once in Supabase's SQL Editor (after the other files).

create table if not exists public.invites (
  id          bigint generated always as identity primary key,
  code        text not null unique default replace(gen_random_uuid()::text, '-', ''),
  name        text not null check (char_length(name) between 1 and 40),
  created_at  timestamptz not null default now(),
  claimed_by  uuid unique references auth.users (id) on delete set null,
  claimed_at  timestamptz
);
alter table public.invites enable row level security;
drop policy if exists "invites: admin only" on public.invites;
create policy "invites: admin only" on public.invites for all using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.invites to authenticated;

-- Whether the signed-in device may use the game: the administrator, or a device that claimed an invite.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (select 1 from invites where claimed_by = auth.uid());
$$;
grant execute on function public.is_member() to anon, authenticated;

create or replace function public.am_member() returns boolean
language sql stable security definer set search_path = public as $$ select public.is_member(); $$;
grant execute on function public.am_member() to anon, authenticated;

-- A device opens its personal link. Returns the name on the invite.
create or replace function public.claim_invite(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare inv invites%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into inv from invites where code = trim(p_code) for update;
  if not found then raise exception 'Invite: this link isn''t valid. Ask the administrator for a new one.'; end if;
  if inv.claimed_by = auth.uid() then return inv.name; end if;
  if inv.claimed_by is not null then
    raise exception 'Invite: this link was already used on another device. Ask the administrator for a new one.';
  end if;
  if exists (select 1 from invites where claimed_by = auth.uid()) then
    raise exception 'Invite: this device already has access.';
  end if;
  update invites set claimed_by = auth.uid(), claimed_at = now() where id = inv.id;
  return inv.name;
end;
$$;
revoke all on function public.claim_invite(text) from public;
grant execute on function public.claim_invite(text) to authenticated;

-- Administrator: give an invite a new link. The device that used the old link loses access.
create or replace function public.reset_invite(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_admin() then raise exception 'Only the administrator can reset invites'; end if;
  update invites set code = replace(gen_random_uuid()::text, '-', ''), claimed_by = null, claimed_at = null
  where id = p_id returning code into c;
  return c;
end;
$$;
revoke all on function public.reset_invite(bigint) from public;
grant execute on function public.reset_invite(bigint) to authenticated;

-- Only members can read the game.
drop policy if exists "games: anyone reads" on public.games;
drop policy if exists "games: members read" on public.games;
create policy "games: members read" on public.games for select using (public.is_member());

drop policy if exists "published lines: anyone reads" on public.published_lines;
drop policy if exists "published lines: members read" on public.published_lines;
create policy "published lines: members read" on public.published_lines for select using (public.is_member());

drop policy if exists "settings: anyone reads" on public.settings;
drop policy if exists "settings: members read" on public.settings;
create policy "settings: members read" on public.settings for select using (public.is_member());

drop policy if exists "boards: anyone reads" on public.boards;
drop policy if exists "boards: members read" on public.boards;
create policy "boards: members read" on public.boards for select using (public.is_member());

drop policy if exists "squares: anyone reads" on public.board_squares;
drop policy if exists "squares: members read" on public.board_squares;
create policy "squares: members read" on public.board_squares for select using (public.is_member());

drop policy if exists "players: add self" on public.players;
create policy "players: add self" on public.players for insert with check (user_id = auth.uid() and public.is_member());

-- Only members can place tickets or claim squares.
do $$
declare d text; sig text;
begin
  foreach sig in array array['public.place_ticket(text,text,int,jsonb)', 'public.claim_square(bigint,int,text)'] loop
    d := pg_get_functiondef(sig::regprocedure);
    if position('is_member' in d) = 0 then
      d := replace(d, $q$if auth.uid() is null then raise exception 'Not signed in'; end if;$q$,
        $q$if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not public.is_member() then raise exception 'Invite only: open your personal invite link on this device'; end if;$q$);
      execute d;
    end if;
  end loop;
end $$;

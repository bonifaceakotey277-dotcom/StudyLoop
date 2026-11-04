-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Creates the table that stores each person's courses, and makes sure
-- every person can only read and change their own rows.

create table if not exists public.user_sems (
  user_id    uuid    not null references auth.users(id) on delete cascade,
  sem_id     text    not null,               -- a course/subject id, or '_meta' (level + study days)
  data       jsonb,                          -- the course contents (null when deleted)
  u          bigint  not null default 0,     -- last-changed time, used to pick the newest copy
  deleted    boolean not null default false, -- marks a deleted course so other devices remove it too
  updated_at timestamptz not null default now(),
  primary key (user_id, sem_id)
);

alter table public.user_sems enable row level security;

drop policy if exists "read own rows"   on public.user_sems;
drop policy if exists "insert own rows" on public.user_sems;
drop policy if exists "update own rows" on public.user_sems;
drop policy if exists "delete own rows" on public.user_sems;

create policy "read own rows"   on public.user_sems for select using (auth.uid() = user_id);
create policy "insert own rows" on public.user_sems for insert with check (auth.uid() = user_id);
create policy "update own rows" on public.user_sems for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own rows" on public.user_sems for delete using (auth.uid() = user_id);

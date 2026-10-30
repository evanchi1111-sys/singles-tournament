-- 賽事封存：存入選手成績時，順便留一份整場比賽的完整結果（排名表、每場比分），英雄榜可以展開查看。
-- 在 Supabase 後台 → SQL Editor 貼上整段，按 Run。可以重複執行。
-- 需要先執行過 people.sql（會用到裡面的 people_is_organizer 函式）。

create table if not exists public.event_archives (
  id         uuid primary key default gen_random_uuid(),
  system     text not null check (system in ('singles', 'doubles', 'team')),
  division   text not null default '',
  year       int  not null check (year between 2000 and 2100),
  event      text not null default '' check (char_length(event) <= 30),
  snapshot   jsonb not null,
  created_at timestamptz not null default now()
);
-- 同一個比賽、組別、年度、賽事名稱只留一份（重新存入會取代舊的）
create unique index if not exists event_archives_unique_idx on public.event_archives (system, division, year, event);

alter table public.event_archives enable row level security;
drop policy if exists "archives public read" on public.event_archives;
create policy "archives public read" on public.event_archives for select using (true);
drop policy if exists "archives organizer write" on public.event_archives;
create policy "archives organizer write" on public.event_archives for all to authenticated
  using (public.people_is_organizer()) with check (public.people_is_organizer());

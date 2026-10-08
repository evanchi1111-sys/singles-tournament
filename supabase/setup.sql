-- =====================================================================
-- 桌球單打賽系統：Supabase 資料庫設定
-- 資料表一律以 sg_ 開頭，可以和其他系統（雙打計分、團體賽排點）共用同一個 Supabase 專案。
-- 用法：Supabase → SQL Editor → New query → 貼上全部內容 → Run
-- 可以重複執行，不會清掉已有的資料。
-- =====================================================================

-- ---------- 1. 資料表 ----------

create table if not exists public.sg_settings (
  id         int primary key default 1 check (id = 1),
  title      text not null default '桌球單打賽' check (char_length(title) between 1 and 40),
  updated_at timestamptz not null default now()
);
insert into public.sg_settings (id) values (1) on conflict (id) do nothing;

-- 每個組別各自的賽制設定
create table if not exists public.sg_divisions (
  id            text primary key check (id in ('competitive', 'fun')),
  format        text not null default 'single' check (format in ('single', 'double', 'groups')), -- 單淘汰／雙淘汰／分組循環
  best_of       int  not null default 3 check (best_of in (3, 5, 7)),                             -- 每場幾局
  group_count   int  not null default 2 check (group_count between 2 and 32),
  advance_count int  not null default 2 check (advance_count between 1 and 8),                    -- 每組晉級人數
  final_format  text not null default 'single' check (final_format in ('single', 'super')),      -- 總決賽：單淘汰／超級循環
  updated_at    timestamptz not null default now()
);
insert into public.sg_divisions (id) values ('competitive'), ('fun') on conflict (id) do nothing;

create table if not exists public.sg_players (
  id         uuid primary key default gen_random_uuid(),
  division   text not null check (division in ('competitive', 'fun')),
  name       text not null check (char_length(btrim(name)) between 1 and 20),
  seed       int  not null default 0,          -- 種子／籤序（越小越前面）
  grp        text,                             -- 分組循環賽的組別（A、B、C…）
  draw_group int check (draw_group between 1 and 99),  -- 預賽戰績完全相同時的抽籤順位
  draw_final int check (draw_final between 1 and 99),  -- 超級循環賽戰績完全相同時的抽籤順位
  created_at timestamptz not null default now(),
  unique (division, name)
);

-- 對戰。淘汰賽的選手由 src1/src2 決定：{"seed": 選手id 或 null(輪空)}、{"win": "代號"}、{"lose": "代號"}
create table if not exists public.sg_matches (
  id         uuid primary key default gen_random_uuid(),
  division   text not null check (division in ('competitive', 'fun')),
  stage      text not null check (stage in ('main', 'group', 'final')),
  code       text not null,
  grp        text,
  round      int  not null default 1,
  idx        int  not null default 0,
  src1       jsonb not null,
  src2       jsonb not null,
  games      jsonb not null default '[]'::jsonb check (jsonb_typeof(games) = 'array'), -- 每局比分 [[11,8],[9,11]...]
  p1_id      uuid,   -- 登錄比分當下的對戰選手（上游結果改變時用來判斷比分是否失效）
  p2_id      uuid,
  updated_at timestamptz not null default now(),
  unique (division, stage, code)
);

create table if not exists public.sg_organizers (
  email text primary key
);

-- ---------- 2. 安全規則（由伺服器執行，網頁無法略過） ----------

create or replace function public.sg_is_organizer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sg_organizers
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.sg_settings   enable row level security;
alter table public.sg_divisions  enable row level security;
alter table public.sg_players    enable row level security;
alter table public.sg_matches    enable row level security;
alter table public.sg_organizers enable row level security;  -- 不設規則 = 網頁完全無法存取

do $$
declare
  t text;
begin
  foreach t in array array['sg_settings', 'sg_divisions', 'sg_players', 'sg_matches'] loop
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
    execute format('drop policy if exists "organizer all" on public.%I', t);
    execute format(
      'create policy "organizer all" on public.%I for all to authenticated
         using (public.sg_is_organizer()) with check (public.sg_is_organizer())', t);
  end loop;
end $$;

-- ---------- 3. 即時同步 ----------

do $$
declare
  t text;
begin
  foreach t in array array['sg_settings', 'sg_divisions', 'sg_players', 'sg_matches'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 4. 主辦帳號 ----------
-- 必須與 js/config.js 的 ORGANIZER_EMAIL、以及 Authentication → Users 的帳號相同。
insert into public.sg_organizers (email) values ('organizer@dsc-table-tennis.app')
on conflict (email) do nothing;

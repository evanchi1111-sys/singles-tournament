-- 選手資料庫（單打賽、雙打賽、團體賽共用）
-- 在 Supabase 後台 → SQL Editor 貼上整段，按 Run。可以重複執行，不會重複建立或覆蓋已有的資料。
-- 以「姓名」當識別：三個系統裡同名的選手視為同一人，共用單位、頭銜與照片。

-- 1. 選手資料表
create table if not exists public.people (
  name       text primary key check (char_length(btrim(name)) between 1 and 40),
  unit       text check (unit  is null or char_length(unit)  <= 40),
  title      text check (title is null or char_length(title) <= 20),
  photo_url  text,
  updated_at timestamptz not null default now()
);

-- 2. 主辦判斷：三個系統任何一個的主辦帳號都可以編輯選手資料（沒有建立的系統會自動略過）
create or replace function public.people_is_organizer()
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  em text := lower(coalesce(auth.jwt() ->> 'email', ''));
  ok boolean := false;
  t  text;
begin
  foreach t in array array['sg_organizers', 'organizers', 'tl_organizers'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select exists (select 1 from public.%I where lower(email) = $1)', t) into ok using em;
      if ok then return true; end if;
    end if;
  end loop;
  return false;
end;
$$;

alter table public.people enable row level security;
drop policy if exists "people public read" on public.people;
create policy "people public read" on public.people for select using (true);
drop policy if exists "people organizer write" on public.people;
create policy "people organizer write" on public.people for all to authenticated
  using (public.people_is_organizer()) with check (public.people_is_organizer());

-- 3. 照片儲存空間（公開可讀，只有主辦帳號可以上傳、更換、刪除）
insert into storage.buckets (id, name, public) values ('people-photos', 'people-photos', true)
on conflict (id) do nothing;

drop policy if exists "people photos public read" on storage.objects;
create policy "people photos public read" on storage.objects
  for select using (bucket_id = 'people-photos');
drop policy if exists "people photos organizer write" on storage.objects;
create policy "people photos organizer write" on storage.objects
  for all to authenticated
  using (bucket_id = 'people-photos' and public.people_is_organizer())
  with check (bucket_id = 'people-photos' and public.people_is_organizer());

-- 4. 實時同步（選手在別處改了資料，這邊畫面也會更新）
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'people') then
    alter publication supabase_realtime add table public.people;
  end if;
end $$;

-- 5. 把單打賽已經填好的單位、頭銜、照片搬進來（同名只取第一筆；已存在的不會被覆蓋）
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sg_players' and column_name = 'photo_url') then
    insert into public.people (name, unit, title, photo_url)
    select distinct on (name) name, unit, title, photo_url
    from public.sg_players
    where unit is not null or title is not null or photo_url is not null
    order by name, created_at
    on conflict (name) do nothing;
  end if;
end $$;

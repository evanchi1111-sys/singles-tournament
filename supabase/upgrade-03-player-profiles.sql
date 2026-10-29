-- 升級 03：選手基本資料（單位、頭銜、照片）
-- 在 Supabase 後台 → SQL Editor 貼上整段，按 Run。可以重複執行，不會重複建立。

-- 1. 選手資料表新增欄位
alter table public.sg_players add column if not exists unit      text check (unit  is null or char_length(unit)  <= 40);
alter table public.sg_players add column if not exists title     text check (title is null or char_length(title) <= 20);
alter table public.sg_players add column if not exists photo_url text;

-- 2. 照片儲存空間（公開可讀，只有主辦帳號可以上傳、更換、刪除）
insert into storage.buckets (id, name, public)
values ('sg-photos', 'sg-photos', true)
on conflict (id) do nothing;

drop policy if exists "sg photos public read" on storage.objects;
create policy "sg photos public read" on storage.objects
  for select using (bucket_id = 'sg-photos');

drop policy if exists "sg photos organizer write" on storage.objects;
create policy "sg photos organizer write" on storage.objects
  for all to authenticated
  using (bucket_id = 'sg-photos' and public.sg_is_organizer())
  with check (bucket_id = 'sg-photos' and public.sg_is_organizer());

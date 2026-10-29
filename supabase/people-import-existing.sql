-- 把三個比賽目前已經登記的選手姓名，一次放進「選手資料庫」（people 資料表）
-- 在 Supabase 後台 → SQL Editor 貼上整段，按 Run。只會新增還沒有的姓名，不會動到已有的單位、頭銜、照片。
-- 注意：如果你已經從資料庫刪除某位選手、他仍在比賽名單裡，重新執行這份會把他再加回來。

do $$
begin
  if to_regclass('public.sg_players') is not null then
    insert into public.people (name)
    select distinct btrim(name) from public.sg_players where char_length(btrim(name)) between 1 and 40
    on conflict (name) do nothing;
  end if;

  if to_regclass('public.teams') is not null then
    insert into public.people (name)
    select distinct n from (
      select btrim(player_a) as n from public.teams
      union
      select btrim(player_b) from public.teams
    ) t where char_length(n) between 1 and 40
    on conflict (name) do nothing;
  end if;

  if to_regclass('public.tl_players') is not null then
    insert into public.people (name)
    select distinct btrim(name) from public.tl_players where char_length(btrim(name)) between 1 and 40
    on conflict (name) do nothing;
  end if;
end $$;

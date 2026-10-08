-- =====================================================================
-- 升級 02：總決賽可選擇是否加打冠軍賽、季軍賽
-- 用法：Supabase → SQL Editor → New query → 貼上 → Run（可重複執行）
-- =====================================================================

alter table public.sg_divisions add column if not exists final_champion boolean not null default false;
alter table public.sg_divisions add column if not exists final_third boolean;

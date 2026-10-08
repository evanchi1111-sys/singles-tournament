-- =====================================================================
-- 升級 01：總決賽（超級循環賽／單淘汰總決賽）可另外設定每場局數
-- 用法：Supabase → SQL Editor → New query → 貼上 → Run（可重複執行）
-- =====================================================================

alter table public.sg_divisions add column if not exists final_best_of int check (final_best_of in (3, 5, 7));

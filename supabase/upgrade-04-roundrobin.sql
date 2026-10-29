-- 升級 04：單打賽新增「單循環賽」賽制（每位選手都和其他所有選手各打一場，沒有淘汰）
-- 在 Supabase 後台 → SQL Editor 貼上整段，按 Run。可以重複執行。
alter table public.sg_divisions drop constraint if exists sg_divisions_format_check;
alter table public.sg_divisions add constraint sg_divisions_format_check
  check (format in ('single', 'double', 'groups', 'roundrobin'));

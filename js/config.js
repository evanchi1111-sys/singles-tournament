// Supabase 專案設定（與雙打計分、團體賽排點系統共用同一個專案）。
// 這兩個值本來就是公開的；真正的安全由資料庫規則（supabase/setup.sql）把關。
// 注意：千萬不要貼上 service_role / secret key。
export const SUPABASE_URL = 'https://agquezkmsyehabgjuwqk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_pqBCZYPukEOYslnHpaCIEQ_teG22t5D';

// 主辦帳號，必須與 supabase/setup.sql 第 4 段的 email 相同
export const ORGANIZER_EMAIL = 'organizer@dsc-table-tennis.app';

import { SUPABASE_URL, SUPABASE_ANON_KEY, ORGANIZER_EMAIL } from './config.js';

export const DEFAULT_DIVISION = { format: 'single', best_of: 3, group_count: 2, advance_count: 2, final_format: 'single' };

export function isConfigured() {
  return /^https:\/\/.+/.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20;
}

export async function createBackend({ demo }) {
  return demo ? createDemoBackend() : createSupabaseBackend();
}

function friendlyError(error) {
  const msg = String(error?.message || error || '');
  if (/invalid login credentials/i.test(msg)) return new Error('帳號或密碼錯誤');
  if (/row-level security|permission denied|42501/i.test(msg) || error?.code === '42501') return new Error('沒有寫入權限，請重新登入主辦帳號');
  if (/duplicate key|23505/i.test(msg) || error?.code === '23505') return new Error('名稱重複，請換一個');
  if (/password should be at least|weak password/i.test(msg)) return new Error('密碼至少需要 6 個字元');
  if (/same.*password|different from the old/i.test(msg)) return new Error('新密碼不能和舊密碼相同');
  if (/failed to fetch|network/i.test(msg)) return new Error('網路連線失敗，請檢查網路後再試');
  if (/sg_/.test(msg) && /schema cache|does not exist/i.test(msg)) return new Error('資料庫尚未設定，請先執行 supabase/setup.sql');
  return new Error(msg || '發生未知錯誤');
}

const toDivisionMap = (rows) => {
  const map = { competitive: { id: 'competitive', ...DEFAULT_DIVISION }, fun: { id: 'fun', ...DEFAULT_DIVISION } };
  for (const r of rows || []) map[r.id] = { ...map[r.id], ...r };
  return map;
};

// ---------------------------------------------------------------- Supabase

async function createSupabaseBackend() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const check = ({ data, error }) => {
    if (error) throw friendlyError(error);
    return data;
  };
  // 被安全規則擋下的寫入不會報錯，只會影響 0 列
  const mustAffect = (result) => {
    const rows = check(result);
    if (!rows || rows.length === 0) throw new Error('沒有寫入權限，請重新登入主辦帳號');
    return rows;
  };
  const now = () => new Date().toISOString();

  return {
    async load() {
      const [settings, divisions, players, matches] = await Promise.all([
        sb.from('sg_settings').select('*').eq('id', 1).maybeSingle(),
        sb.from('sg_divisions').select('*'),
        sb.from('sg_players').select('*').order('seed').order('created_at'),
        sb.from('sg_matches').select('*'),
      ]);
      return {
        settings: check(settings) || { title: '桌球單打賽' },
        divisions: toDivisionMap(check(divisions)),
        players: check(players),
        matches: check(matches),
      };
    },
    subscribe(onChange, onStatus = () => {}) {
      const channel = sb.channel('singles');
      for (const table of ['sg_settings', 'sg_divisions', 'sg_players', 'sg_matches']) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
      }
      channel.subscribe((status) => onStatus(status));
      return () => sb.removeChannel(channel);
    },

    async getUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuthChange(callback) {
      const { data } = sb.auth.onAuthStateChange((_e, session) => callback(session?.user ?? null));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw friendlyError(error);
    },
    async signOut() { await sb.auth.signOut(); },
    async changePassword(email, currentPassword, newPassword) {
      const verify = await sb.auth.signInWithPassword({ email, password: currentPassword });
      if (verify.error) throw new Error('目前密碼錯誤');
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (error) throw friendlyError(error);
    },

    async updateSettings(patch) {
      mustAffect(await sb.from('sg_settings').update({ ...patch, updated_at: now() }).eq('id', 1).select());
    },
    async updateDivision(id, patch) {
      mustAffect(await sb.from('sg_divisions').update({ ...patch, updated_at: now() }).eq('id', id).select());
    },
    async addPlayers(rows) {
      check(await sb.from('sg_players').insert(rows));
    },
    // 批次更新選手（種子順序、分組、抽籤）：傳入完整的選手資料
    async savePlayers(rows) {
      if (rows.length) mustAffect(await sb.from('sg_players').upsert(rows).select());
    },
    async deletePlayer(id) {
      mustAffect(await sb.from('sg_players').delete().eq('id', id).select());
    },
    async createMatches(rows) {
      if (rows.length) check(await sb.from('sg_matches').insert(rows));
    },
    async updateMatch(id, patch) {
      mustAffect(await sb.from('sg_matches').update({ ...patch, updated_at: now() }).eq('id', id).select());
    },
    async deleteMatches(division, stages) {
      await this.updateDivision(division, {}); // 先確認有主辦權限
      check(await sb.from('sg_matches').delete().eq('division', division).in('stage', stages));
    },
    async wipe() {
      await this.updateSettings({});
      check(await sb.from('sg_matches').delete().not('id', 'is', null));
      check(await sb.from('sg_players').delete().not('id', 'is', null));
    },
  };
}

// ---------------------------------------------------------------- 示範模式

function createDemoBackend() {
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  const DEMO_PASSWORD = 'demo1234';
  const t0 = Date.now();
  const db = {
    settings: { title: '桌球單打賽' },
    divisions: toDivisionMap([]),
    players: [],
    matches: [],
  };
  const seedNames = {
    competitive: ['陳志明', '林建宏', '黃俊傑', '張家豪', '李承翰', '王冠宇', '吳宗憲', '劉育成', '蔡明哲', '鄭凱文'],
    fun: ['許家銘', '郭建志', '洪偉倫', '邱冠廷', '周子豪', '曾柏翰', '彭俊宏'],
  };
  for (const [division, names] of Object.entries(seedNames)) {
    names.forEach((name, i) => db.players.push({ id: uid(), division, name, seed: i + 1, grp: null, draw_group: null, draw_final: null, created_at: new Date(t0 + i).toISOString() }));
  }
  let user = null;
  const dataListeners = new Set();
  const authListeners = new Set();
  const emit = () => setTimeout(() => dataListeners.forEach((fn) => fn()), 30);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const requireOrganizer = () => { if (!user) throw new Error('沒有寫入權限，請重新登入主辦帳號'); };

  return {
    isDemo: true,
    demoPassword: DEMO_PASSWORD,
    async load() { return clone(db); },
    subscribe(onChange, onStatus = () => {}) {
      dataListeners.add(onChange);
      setTimeout(() => onStatus('SUBSCRIBED'), 0);
      return () => dataListeners.delete(onChange);
    },
    async getUser() { return user; },
    onAuthChange(cb) { authListeners.add(cb); return () => authListeners.delete(cb); },
    async signIn(email, password) {
      if (email.toLowerCase() !== ORGANIZER_EMAIL.toLowerCase() || password !== DEMO_PASSWORD) throw new Error('帳號或密碼錯誤');
      user = { email: ORGANIZER_EMAIL };
      authListeners.forEach((fn) => fn(user));
    },
    async signOut() { user = null; authListeners.forEach((fn) => fn(null)); },
    async changePassword() { throw new Error('示範模式無法變更密碼'); },
    async updateSettings(patch) { requireOrganizer(); Object.assign(db.settings, patch); emit(); },
    async updateDivision(id, patch) { requireOrganizer(); Object.assign(db.divisions[id], patch); emit(); },
    async addPlayers(rows) {
      requireOrganizer();
      for (const r of rows) {
        if (db.players.some((p) => p.division === r.division && p.name === r.name)) throw new Error('名稱重複，請換一個');
        db.players.push({ id: uid(), grp: null, draw_group: null, draw_final: null, created_at: new Date().toISOString(), ...r });
      }
      emit();
    },
    async savePlayers(rows) {
      requireOrganizer();
      for (const r of rows) Object.assign(db.players.find((p) => p.id === r.id), r);
      emit();
    },
    async deletePlayer(id) { requireOrganizer(); db.players = db.players.filter((p) => p.id !== id); emit(); },
    async createMatches(rows) {
      requireOrganizer();
      rows.forEach((r) => db.matches.push({ id: uid(), games: [], p1_id: null, p2_id: null, grp: null, ...r }));
      emit();
    },
    async updateMatch(id, patch) { requireOrganizer(); Object.assign(db.matches.find((m) => m.id === id), patch); emit(); },
    async deleteMatches(division, stages) {
      requireOrganizer();
      db.matches = db.matches.filter((m) => !(m.division === division && stages.includes(m.stage)));
      emit();
    },
    async wipe() { requireOrganizer(); db.matches = []; db.players = []; emit(); },
  };
}

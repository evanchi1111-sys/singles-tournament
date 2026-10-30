// 選手資料庫（三個比賽系統與「選手資料庫」頁共用的程式，四個專案各放一份相同的檔案）
// 資料表 people：以「姓名」當唯一識別，同名視為同一人。存單位、頭銜、照片網址。

const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const TITLE_SUGGESTIONS = ['選手', '種子選手', '隊長', '教練', '領隊', '裁判'];
export const PHOTO_BUCKET = 'people-photos';

// ---------------------------------------------------------------- 頭像與標籤

// 沒有照片時的頭像底色：取自企業識別色（藍、黃、灰）的淺色階
const AVATAR_COLORS = [['#d3e3f6', '#1f4f86'], ['#ffeb99', '#5c4800'], ['#e2e2e2', '#444242'], ['#bfe0f5', '#1d5680'], ['#ffe066', '#523f00'], ['#cdd9e8', '#2e4a6b'], ['#f1f1f1', '#666464']];
const avatarColor = (name) => AVATAR_COLORS[[...String(name)].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

// person = { name, photo_url }。有照片顯示照片，沒有就顯示姓名最後兩個字
export function avatar(person, size = 'sm') {
  if (!person || !person.name) return `<span class="av ${size}" aria-hidden="true">?</span>`;
  if (person.photo_url) return `<span class="av ${size}"><img src="${escape(person.photo_url)}" alt="" loading="lazy"></span>`;
  const [bg, fg] = avatarColor(person.name);
  return `<span class="av ${size}" style="background:${bg};color:${fg}" aria-hidden="true">${escape([...person.name].slice(-2).join(''))}</span>`;
}

export function titleChip(title) {
  if (!title) return '';
  const kind = title === '教練' || title === '領隊' ? 'coach' : /種子|隊長/.test(title) ? 'seed' : '';
  return `<span class="ttl ${kind}">${escape(title)}</span>`;
}

// 取得某位選手的完整資料：資料庫有就用資料庫，沒有就用備用資料（舊欄位）
export const profileOf = (people, name, fallback = {}) => ({
  name,
  unit: null,
  title: null,
  photo_url: null,
  ...fallback,
  ...(people?.[name] || {}),
});

// ---------------------------------------------------------------- 照片處理

// 置中裁成 3:4、縮到 480×640，轉成 JPEG（手機相機原圖動輒數 MB）
export async function resizePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const W = 480;
  const H = 640;
  const scale = Math.max(W / bitmap.width, H / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bitmap, (W - bitmap.width * scale) / 2, (H - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('照片處理失敗'))), 'image/jpeg', 0.85));
}

// ---------------------------------------------------------------- 資料存取

const friendly = (error) => {
  const msg = String(error?.message || error || '');
  if (/relation .*people.* does not exist|could not find the table|schema cache/i.test(msg)) return new Error('選手資料庫尚未建立，請先在 Supabase 執行 people.sql');
  if (/bucket not found/i.test(msg)) return new Error('照片儲存空間尚未建立，請先在 Supabase 執行 people.sql');
  if (/row-level security|permission denied|42501/i.test(msg) || error?.code === '42501') return new Error('沒有寫入權限，請重新登入主辦帳號');
  return new Error(msg || '發生未知錯誤');
};

// 連到 Supabase 的版本：sb 是 supabase client
export function peopleApi(sb) {
  return {
    // 讀取全部選手資料，回傳 { 姓名: 資料 }。資料表還沒建立時回傳空的，網頁照常運作
    async load() {
      const { data, error } = await sb.from('people').select('*');
      if (error) return {};
      return Object.fromEntries(data.map((p) => [p.name, p]));
    },
    async remove(name) {
      const { data, error } = await sb.from('people').delete().eq('name', name).select();
      if (error) throw friendly(error);
      if (!data || !data.length) throw new Error('沒有刪除到任何資料：這位選手可能已經被刪除，或目前的登入沒有刪除權限');
    },
    async save(name, patch) {
      const row = { name, ...patch, updated_at: new Date().toISOString() };
      const { data, error } = await sb.from('people').upsert(row, { onConflict: 'name' }).select();
      if (error) throw friendly(error);
      if (!data || !data.length) throw new Error('沒有寫入權限，請重新登入主辦帳號');
    },
    async upload(blob) {
      const path = `${crypto.randomUUID ? crypto.randomUUID() : Date.now()}.jpg`;
      const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
      if (error) throw friendly(error);
      return sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
    },
  };
}

// 示範模式的版本：資料只存在記憶體，照片轉成網址字串
export function demoPeopleApi(seed = {}) {
  const store = { ...seed };
  return {
    async load() { return JSON.parse(JSON.stringify(store)); },
    async remove(name) { delete store[name]; },
    async save(name, patch) { store[name] = { ...(store[name] || {}), name, ...patch }; },
    upload(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('照片讀取失敗'));
        reader.readAsDataURL(blob);
      });
    },
  };
}

// ---------------------------------------------------------------- 編輯視窗（單位、頭銜、照片）

// openModal：各系統自己的對話框函式 (html, onReady(modal, close))
// person：{ name, unit, title, photo_url }
// onSave(patch)：patch = { unit, title, photo_url }；需自行處理上傳與錯誤，成功回傳 true 才會關閉視窗
export function openPersonEditor({ openModal, person, onSave }) {
  openModal(`
    <h2>${person.name ? `編輯 ${escape(person.name)} 的資料` : "新增選手"}</h2>
    <form>
      <div class="photo-edit">
        <div class="photo-preview" id="photo-preview">${avatar(person, 'big')}</div>
        <div class="photo-ctl">
          <label class="btn small file-btn">選擇照片<input name="photo" type="file" accept="image/*" hidden></label>
          <button type="button" class="btn small danger" data-remove-photo ${person.photo_url ? '' : 'hidden'}>移除照片</button>
          <p class="note">照片會自動置中裁成直式 3:4，並縮小後上傳。</p>
        </div>
      </div>
      ${person.name ? "" : `<label>姓名<input name="name" maxlength="40" required placeholder="例：王小明" autocomplete="off"></label>`}
      <label>單位<input name="unit" maxlength="40" placeholder="例：新北市桌球隊" value="${escape(person.unit || '')}"></label>
      <label>頭銜<input name="title" maxlength="20" list="title-list" placeholder="例：種子選手" value="${escape(person.title || '')}"></label>
      <datalist id="title-list">${TITLE_SUGGESTIONS.map((t) => `<option value="${t}">`).join('')}</datalist>
      <p class="note">資料存在「選手資料庫」，同名的選手在單打、雙打、團體賽會共用。</p>
      <p class="error" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" data-close>取消</button><button class="btn primary">儲存</button></div>
    </form>`,
  (modal, close) => {
    const form = modal.querySelector('form');
    const preview = modal.querySelector('#photo-preview');
    const removeBtn = modal.querySelector('[data-remove-photo]');
    const errorEl = form.querySelector('.error');
    let newBlob = null;
    let removed = false;
    form.photo.addEventListener('change', async () => {
      const file = form.photo.files[0];
      if (!file) return;
      try {
        newBlob = await resizePhoto(file);
        removed = false;
        preview.innerHTML = `<span class="av big"><img src="${URL.createObjectURL(newBlob)}" alt=""></span>`;
        removeBtn.hidden = false;
      } catch {
        errorEl.textContent = '這個檔案無法當作照片，請換一張圖片';
        errorEl.hidden = false;
      }
    });
    removeBtn.addEventListener('click', () => {
      newBlob = null;
      removed = true;
      form.photo.value = '';
      preview.innerHTML = avatar({ ...person, photo_url: null }, 'big');
      removeBtn.hidden = true;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const ok = await onSave({ name: form.name ? form.name.value.trim() : person.name, unit: form.unit.value.trim() || null, title: form.title.value.trim() || null, blob: newBlob, removed });
      if (ok) close();
    });
  });
}

// ---------------------------------------------------------------- 從選手資料庫挑選參賽選手

// 選手資料庫頁的網址（找不到選手時，引導主辦到那裡新增）
export function hubUrl() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const demo = new URLSearchParams(location.search).has('demo');
  return (local ? 'http://localhost:8769/' : '/players/') + (demo ? '?demo' : '');
}

// 挑選視窗：從選手資料庫勾選參賽選手。
//   people：選手資料庫 { 姓名: 資料 }；extra：資料庫沒有、但已經登記在這個項目裡的姓名
//   selected：目前已選的姓名；disabled：{ 姓名: 不能選的原因 }
//   min / max：至少、最多要選幾位；onConfirm(姓名陣列)：回傳 true 才關閉視窗
export function openPeoplePicker({ openModal, people, extra = [], selected = [], disabled = {}, title = '從選手資料庫挑選', hint = '', min = 0, max = Infinity, confirmLabel = '確定', onConfirm }) {
  const names = [...new Set([...Object.keys(people || {}), ...extra, ...selected])].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const chosen = new Set(selected);
  const row = (name) => {
    const p = profileOf(people, name);
    const why = disabled[name];
    return `<label class="pick-row ${why ? 'is-disabled' : ''}" data-name="${escape(name)}" data-search="${escape([name, p.unit, p.title].filter(Boolean).join(' ').toLowerCase())}">
      <input type="checkbox" value="${escape(name)}" ${chosen.has(name) ? 'checked' : ''} ${why ? 'disabled' : ''}>
      ${avatar(p, 'sm')}
      <span class="who-tx"><span class="team">${escape(name)}</span><small class="who-sub">${escape([p.unit, p.title].filter(Boolean).join(' · ') || '（未填單位）')}${why ? ` ・${escape(why)}` : ''}</small></span>
    </label>`;
  };
  openModal(`
    <h2>${escape(title)}</h2>
    ${hint ? `<p class="note">${escape(hint)}</p>` : ''}
    <input class="pick-search" type="search" placeholder="搜尋姓名、單位或頭銜" aria-label="搜尋選手" autocomplete="off">
    <div class="pick-list" role="group" aria-label="選手清單">
      ${names.length ? names.map(row).join('') : '<p class="note">選手資料庫還沒有選手。</p>'}
    </div>
    <p class="note">找不到選手？<a href="${hubUrl()}" target="_blank" rel="noopener">到選手資料庫新增</a>，再回來重新開啟這個視窗。</p>
    <p class="error" hidden></p>
    <div class="modal-actions pick-actions">
      <span class="pick-count"></span>
      <button type="button" class="btn" data-close>取消</button>
      <button type="button" class="btn primary" data-confirm>${escape(confirmLabel)}</button>
    </div>`,
  (modal, close) => {
    const boxes = [...modal.querySelectorAll('.pick-list input[type=checkbox]')];
    const count = modal.querySelector('.pick-count');
    const errorEl = modal.querySelector('.error');
    const refresh = () => {
      const n = boxes.filter((b) => b.checked).length;
      count.textContent = `已選 ${n} 位`;
      // 已達上限時，其他選項暫時不能再勾
      boxes.forEach((b) => { if (!disabled[b.value]) b.disabled = !b.checked && n >= max; });
    };
    refresh();
    boxes.forEach((b) => b.addEventListener('change', refresh));
    modal.querySelector('.pick-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      modal.querySelectorAll('.pick-row').forEach((r) => { r.hidden = !!q && !r.dataset.search.includes(q); });
    });
    modal.querySelector('[data-confirm]').addEventListener('click', async () => {
      const picked = boxes.filter((b) => b.checked).map((b) => b.value);
      errorEl.hidden = true;
      if (picked.length < min) { errorEl.textContent = min === max ? `請選 ${min} 位` : `至少要選 ${min} 位`; errorEl.hidden = false; return; }
      if (await onConfirm(picked)) close();
    });
  });
}

// ---------------------------------------------------------------- 選手歷年成績（年度冠、亞、季軍）

export const SYSTEM_LABEL = { singles: '單打賽', doubles: '雙打賽', team: '團體賽' };
export const DIVISION_LABEL = { competitive: '競賽組', fun: '歡樂成長組' };
export const PLACE_LABEL = { 1: '冠軍', 2: '亞軍', 3: '季軍' };
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

const groupResults = (rows) => {
  const out = {};
  for (const r of rows) (out[r.name] ||= []).push(r);
  for (const list of Object.values(out)) list.sort((a, b) => b.year - a.year || a.place - b.place);
  return out;
};

// 連到 Supabase 的版本：讀取全部成績（表格還沒建立時回傳空的），並依系統、組別、年度整批取代
export function resultsApi(sb) {
  return {
    async load() {
      const { data, error } = await sb.from('results').select('*');
      return error ? {} : groupResults(data);
    },
    // 同一個比賽、組別、年度、賽事名稱重新存入時，先清掉舊紀錄再寫入新的（名次改了也不會留下舊資料）
    async replace(system, division, year, event, rows) {
      const del = await sb.from('results').delete().eq('system', system).eq('division', division).eq('year', year).eq('event', event);
      if (del.error) throw friendly(del.error);
      if (!rows.length) return;
      const { error } = await sb.from('results').insert(rows.map((r) => ({ ...r, system, division, year, event })));
      if (error) throw friendly(error);
    },
    async remove(id) {
      const { data, error } = await sb.from('results').delete().eq('id', id).select();
      if (error) throw friendly(error);
      if (!data || !data.length) throw new Error('沒有寫入權限，請重新登入主辦帳號');
    },
    // 整批撤銷：刪掉同一個比賽、組別、年度、賽事名稱的所有成績
    async removeBatch(system, division, year, event) {
      const { data, error } = await sb.from('results').delete().eq('system', system).eq('division', division).eq('year', year).eq('event', event).select();
      if (error) throw friendly(error);
      if (!data || !data.length) throw new Error('沒有刪除到任何成績（可能沒有權限，請重新登入主辦帳號）');
    },
  };
}

// 示範模式的版本：只存在記憶體
export function demoResultsApi(seed = []) {
  let rows = seed.map((r, i) => ({ id: `demo-${i}`, event: '', ...r }));
  const sameBatch = (r, system, division, year, event) => r.system === system && r.division === division && r.year === year && (r.event || '') === event;
  return {
    async load() { return groupResults(JSON.parse(JSON.stringify(rows))); },
    async replace(system, division, year, event, list) {
      rows = rows.filter((r) => !sameBatch(r, system, division, year, event));
      list.forEach((r, i) => rows.push({ id: `demo-${Date.now()}-${i}`, created_at: new Date().toISOString(), ...r, system, division, year, event }));
    },
    async remove(id) { rows = rows.filter((r) => r.id !== id); },
    async removeBatch(system, division, year, event) { rows = rows.filter((r) => !sameBatch(r, system, division, year, event)); },
  };
}

// ---------------------------------------------------------------- 賽事封存（完整比賽結果）
// 存入成績時順便留一份整場比賽的結果（排名表、每場比分）：event_archives 資料表，英雄榜點賽事可展開查看。
// snapshot：{ formatLabel, placings: [{ place, name }], tables: [{ title, head: [], rows: [[]] }], matches: [{ stage, round, p1, p2, score, games, winner, lines? }] }

export function archiveApi(sb) {
  const batch = (q, system, division, year, event) => q.eq('system', system).eq('division', division).eq('year', year).eq('event', event);
  return {
    async load() {
      const { data, error } = await sb.from('event_archives').select('*');
      return error ? [] : data;
    },
    // 同一個比賽、組別、年度、賽事名稱重新存入時取代舊的封存
    async replace(system, division, year, event, snapshot) {
      const del = await batch(sb.from('event_archives').delete(), system, division, year, event);
      if (del.error) throw friendly(del.error);
      const { error } = await sb.from('event_archives').insert({ system, division, year, event, snapshot });
      if (error) throw friendly(error);
    },
    async removeBatch(system, division, year, event) {
      await batch(sb.from('event_archives').delete(), system, division, year, event);
    },
  };
}

export function demoArchiveApi(seed = []) {
  let rows = seed.map((r, i) => ({ id: `demo-a${i}`, event: '', ...r }));
  const same = (r, system, division, year, event) => r.system === system && r.division === division && r.year === year && (r.event || '') === event;
  return {
    async load() { return JSON.parse(JSON.stringify(rows)); },
    async replace(system, division, year, event, snapshot) {
      rows = rows.filter((r) => !same(r, system, division, year, event));
      rows.push({ id: `demo-a${Date.now()}`, system, division, year, event, snapshot: JSON.parse(JSON.stringify(snapshot)) });
    },
    async removeBatch(system, division, year, event) { rows = rows.filter((r) => !same(r, system, division, year, event)); },
  };
}

// 存入成績後又改了比分：最近存入的成績和目前名次不同時，回傳 { event, year } 提醒主辦重新存入；一樣或沒有關聯時回傳 null
// current：目前名次 [{ name, place }]（團體賽、雙打是每位選手一筆，和存入的格式相同）
export function staleSaved(resultsMap, system, division, current) {
  if (!current?.length) return null;
  const batches = new Map();
  for (const list of Object.values(resultsMap || {})) {
    for (const r of list) {
      if (r.system !== system || (r.division || '') !== (division || '')) continue;
      const key = `${r.year}|${r.event || ''}`;
      if (!batches.has(key)) batches.set(key, { year: r.year, event: r.event || '', at: '', pairs: new Set(), names: new Set() });
      const b = batches.get(key);
      b.pairs.add(`${r.name}|${r.place}`);
      b.names.add(r.name);
      if ((r.created_at || '') > b.at) b.at = r.created_at || '';
    }
  }
  if (!batches.size) return null;
  const latest = [...batches.values()].sort((a, b) => b.at.localeCompare(a.at) || b.year - a.year)[0];
  const now = new Set(current.map((c) => `${c.name}|${c.place}`));
  const same = latest.pairs.size === now.size && [...now].every((x) => latest.pairs.has(x));
  if (same || !current.some((c) => latest.names.has(c.name))) return null; // 完全沒有相同選手，多半是另一場新比賽
  return { event: latest.event, year: latest.year };
}

// 提醒文字（HTML）
export const staleNoteHtml = (stale) => (stale
  ? `<p class="banner warn">最近存入的「${escape(stale.event || '未命名賽事')}」（${stale.year}）成績和目前名次不同。如果是同一場比賽，請按「存入選手成績」重新存入（賽事名稱和年度要相同，才會取代舊的成績與封存）。</p>`
  : '');

// 把全部成績整理成「批次」：同一個比賽、組別、年度、賽事名稱算一批（選手資料庫頁用來整批撤銷）
export function batchesOf(resultsMap) {
  const map = new Map();
  for (const list of Object.values(resultsMap || {})) {
    for (const r of list) {
      const key = [r.system, r.division, r.year, r.event || ''].join('|');
      if (!map.has(key)) map.set(key, { system: r.system, division: r.division, year: r.year, event: r.event || '', count: 0 });
      map.get(key).count++;
    }
  }
  return [...map.values()].sort((a, b) => b.year - a.year || a.system.localeCompare(b.system));
}

// 存入成績的確認視窗：顯示要記錄的名單，並要求填賽事名稱與年度
// summary：要記錄的名單文字（多行）；onConfirm({ year, event })：回傳 true 才關閉視窗
export function openSaveResultsDialog({ openModal, summary, defaultYear = new Date().getFullYear(), onConfirm }) {
  openModal(`
    <h2>存入選手成績</h2>
    <pre class="save-summary">${escape(summary)}</pre>
    <form>
      <label>賽事名稱（必填，例：2026 春季盃）<input name="event" maxlength="30" required autocomplete="off" placeholder="正式賽事的名稱"></label>
      <label>年度<input name="year" type="number" min="2000" max="2100" required value="${defaultYear}"></label>
      <p class="note">只在<b>正式比賽</b>結束後存入。測試請用示範模式（網址加 <code>?demo</code>）。存入時會一併封存整場比賽的完整結果（排名與每場比分），英雄榜可以展開查看。存錯了可以到「選手資料庫」頁整批撤銷。</p>
      <p class="error" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" data-close>取消</button><button class="btn primary">存入成績</button></div>
    </form>`,
  (modal, close) => {
    const form = modal.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const event = form.event.value.trim();
      const year = Number(form.year.value);
      const errorEl = form.querySelector('.error');
      if (!event) { errorEl.textContent = '請填賽事名稱'; errorEl.hidden = false; return; }
      if (!Number.isInteger(year) || year < 2000 || year > 2100) { errorEl.textContent = '年度請輸入 4 位數，例如 2026'; errorEl.hidden = false; return; }
      if (await onConfirm({ year, event })) close();
    });
  });
}

// 選手檔案裡的「歷年成績」區塊。list 是這位選手的成績陣列；removable 為真時（主辦）每筆可刪除
export function resultsHtml(list, { removable = false, title = '歷年成績' } = {}) {
  const items = (list || []).map((r) => `
    <li class="place-${r.place}">
      <span class="medal">${MEDAL[r.place]}</span>
      <span class="res-tx"><b>${r.year} 年${r.event ? ` ${escape(r.event)}` : ''}</b>
        <small>${SYSTEM_LABEL[r.system] || ''}${r.division ? `・${DIVISION_LABEL[r.division] || r.division}` : ''}・${PLACE_LABEL[r.place]}${r.detail ? `・${escape(r.detail)}` : ''}</small></span>
      ${removable ? `<button type="button" class="icon-btn" data-del-result="${escape(r.id)}" aria-label="刪除這筆成績">✕</button>` : ''}
    </li>`).join('');
  return `<h3 class="profile-h">${escape(title)}</h3>${items ? `<ul class="result-list">${items}</ul>` : '<p class="note">還沒有冠、亞、季軍紀錄。</p>'}`;
}

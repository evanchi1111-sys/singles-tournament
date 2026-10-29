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
    <h2>編輯 ${escape(person.name)} 的資料</h2>
    <form>
      <div class="photo-edit">
        <div class="photo-preview" id="photo-preview">${avatar(person, 'big')}</div>
        <div class="photo-ctl">
          <label class="btn small file-btn">選擇照片<input name="photo" type="file" accept="image/*" hidden></label>
          <button type="button" class="btn small danger" data-remove-photo ${person.photo_url ? '' : 'hidden'}>移除照片</button>
          <p class="note">照片會自動置中裁成直式 3:4，並縮小後上傳。</p>
        </div>
      </div>
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
      const ok = await onSave({ unit: form.unit.value.trim() || null, title: form.title.value.trim() || null, blob: newBlob, removed });
      if (ok) close();
    });
  });
}

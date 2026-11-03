// 記分台：球桌場地圖 ＋ 待賽清單（單打、雙打、團體三個比賽系統共用，四個專案各放一份相同的檔案）。
// 各系統把自己的對戰轉成「項目」{ key, div, round, playable, done, ids }：
//   playable＝雙方已確定且還沒打完；done＝已完賽；ids＝這場的所有參賽者（單打 2 人、雙打 4 人、團體 2 隊），用來算休息與避開同時上場。
// 兩個組別的場次放在同一份清單，系統依「選手剛打完幾場」建議下一場；主辦可以隨時手動調整。
// 桌況（哪張桌子在打哪一場、出賽紀錄）只存在記分的這台電腦（localStorage），不寫進資料庫。

export const DESK_DEFAULT = { tables: 5, rest: 1, auto: true, assign: {}, history: [], pins: [], filter: 'all' };

export function loadDesk(raw) {
  try {
    const d = JSON.parse(raw);
    return { ...DESK_DEFAULT, ...d, assign: { ...(d.assign || {}) }, history: [...(d.history || [])], pins: [...(d.pins || [])] };
  } catch {
    return { ...DESK_DEFAULT, assign: {}, history: [], pins: [] };
  }
}

// 這位選手距離上次排上桌過了幾場（從沒打過回傳很大的數字）
function gapOf(desk, pid) {
  for (let i = desk.history.length - 1; i >= 0; i--) if (desk.history[i].ids.includes(pid)) return desk.history.length - 1 - i;
  return 999;
}
const required = (desk) => desk.rest * desk.tables; // 「隔 N 輪」換算成「隔幾場」：每輪約等於桌數

// 目前在桌上的選手
function busyIds(desk, infos) {
  const ids = new Set();
  for (const key of Object.values(desk.assign)) {
    const it = infos.get(key);
    if (it) it.ids.forEach((id) => ids.add(id));
  }
  return ids;
}

// 待賽清單（不含已上桌的）：依建議順序排好，並標出休息狀況。
// 順序：避開正在比賽的選手 → 優先清單 → 休息夠久的 → 還剩場次最多的選手 → 休息最久 → 輪次較前面
export function buildQueue(desk, infos) {
  const onTable = new Set(Object.values(desk.assign));
  const busy = busyIds(desk, infos);
  const need = required(desk);
  // 每位選手還有幾場沒打（含正在桌上的）：剩得多的人優先排，才不會最後剩幾位選手只能連續上場
  const load = new Map();
  for (const it of infos.values()) {
    if (!it.playable) continue;
    for (const id of it.ids) load.set(id, (load.get(id) || 0) + 1);
  }
  const list = [...infos.values()].filter((it) => it.playable && !onTable.has(it.key)).map((it, idx) => {
    const gaps = it.ids.map((id) => gapOf(desk, id));
    const tired = it.ids.filter((id, k) => gaps[k] < need);
    return { ...it, idx, gap: Math.min(...gaps), load: it.ids.reduce((sum, id) => sum + (load.get(id) || 0), 0), tired, ok: tired.length === 0, blocked: it.ids.some((id) => busy.has(id)), pinned: desk.pins.includes(it.key) };
  });
  list.sort((a, b) => (a.blocked - b.blocked)
    || (b.pinned - a.pinned)
    || (b.ok - a.ok)
    || (a.ok ? b.load - a.load || b.gap - a.gap : b.gap - a.gap || b.load - a.load)
    || a.round - b.round
    || a.idx - b.idx);
  return list;
}

export function emptyTables(desk) {
  return Array.from({ length: desk.tables }, (_, i) => i + 1).filter((n) => !desk.assign[n]);
}

export function assign(desk, table, item) {
  desk.assign[table] = item.key;
  desk.history.push({ key: item.key, ids: [...item.ids] });
  if (desk.history.length > 300) desk.history.splice(0, desk.history.length - 300);
  desk.pins = desk.pins.filter((k) => k !== item.key);
}

export function release(desk, table, { undo = false } = {}) {
  const key = desk.assign[table];
  delete desk.assign[table];
  if (undo && key) {
    const i = desk.history.map((h) => h.key).lastIndexOf(key);
    if (i >= 0) desk.history.splice(i, 1);
  }
}

// 把空桌依建議順序排滿；回傳排上桌的場數與有人剛打完的場數
export function fillTables(desk, infos, tables = emptyTables(desk)) {
  let placed = 0;
  let tired = 0;
  for (const n of tables) {
    if (desk.assign[n]) continue;
    const pick = buildQueue(desk, infos).find((q) => !q.blocked);
    if (!pick) break;
    assign(desk, n, pick);
    placed++;
    if (!pick.ok) tired++;
  }
  return { placed, tired };
}

// 清掉已經打完（或賽程被重設）的桌子；回傳被清掉的桌號
export function syncDesk(desk, infos) {
  const freed = [];
  for (const [n, key] of Object.entries(desk.assign)) {
    const it = infos.get(key);
    if (!it || it.done) { delete desk.assign[n]; freed.push(Number(n)); }
  }
  for (const n of Object.keys(desk.assign)) if (Number(n) > desk.tables) delete desk.assign[n];
  desk.pins = desk.pins.filter((k) => infos.has(k) && infos.get(k).playable);
  return freed;
}

// ---------------------------------------------------------------- 畫面

// ctx：{ esc, nameOf, avatarOf, playerById, divisionLabel, labelOf(item), scoreOf(item), isBusy }
export function renderDesk(desk, infos, ctx) {
  const { esc } = ctx;
  const queue = buildQueue(desk, infos);
  const empties = emptyTables(desk);
  const shown = queue.filter((q) => desk.filter === 'all' || q.div === desk.filter);
  const vs = (it) => ctx.vsHtml(it);
  const multi = Object.keys(ctx.divisions).length > 1;
  const who = ctx.who || '選手';

  const tableCard = (n) => {
    const key = desk.assign[n];
    const it = key && infos.get(key);
    if (!it) {
      return `<div class="dk-table empty t${n}"><div class="dk-th"><b>${n} 號桌</b><span class="dk-tag idle">空桌</span></div>
        <p class="dk-empty">目前沒有比賽</p>
        <button type="button" class="btn small primary" data-action="desk-fill-one" data-table="${n}" ${queue.some((q) => !q.blocked) ? '' : 'disabled'}>排入建議場次</button></div>`;
    }
    const score = ctx.scoreOf(it);
    return `<div class="dk-table busy t${n}"><div class="dk-th"><b>${n} 號桌</b>${multi ? `<span class="dk-tag ${it.div}">${esc(ctx.divisionLabel(it.div))}</span>` : ''}</div>
      <p class="dk-lab">${esc(ctx.labelOf(it))}</p>
      <div class="dk-vs">${vs(it)}</div>
      ${score ? `<p class="dk-score">目前 ${esc(score)}</p>` : ''}
      <div class="dk-act"><button type="button" class="btn small primary" data-action="desk-score" data-table="${n}">登錄比分</button>
        <button type="button" class="btn small" data-action="desk-release" data-table="${n}">撤下</button></div></div>`;
  };

  const tables = Array.from({ length: desk.tables }, (_, i) => i + 1);
  const plan = desk.tables === 5
    ? `<div class="dk-plan plan5"><div class="dk-room" aria-hidden="true">兒童閱覽室</div>${tables.map(tableCard).join('')}</div>`
    : `<div class="dk-plan planN">${tables.map(tableCard).join('')}</div>`;

  const chip = (value, label) => `<button type="button" class="${desk.filter === value ? 'on' : ''}" data-action="desk-filter" data-value="${value}">${esc(label)}</button>`;
  const restNote = (q) => {
    if (q.blocked) return `<span class="dk-rest wait">${who}比賽中</span>`;
    if (q.ok) return `<span class="dk-rest ok">${q.gap >= 999 ? '尚未出賽' : `休息 ${q.gap} 場`}</span>`;
    return `<span class="dk-rest warn">⚠ ${q.tired.map((id) => esc(ctx.nameOf(id))).join('、')} 剛打完</span>`;
  };
  const row = (q, i) => `<li class="dk-item ${q.blocked ? 'blocked' : ''} ${q.pinned ? 'pinned' : ''}">
      <span class="dk-no">${i + 1}</span>
      <div class="dk-body"><div class="dk-meta">${multi ? `<span class="dk-tag ${q.div}">${esc(ctx.divisionLabel(q.div))}</span> ` : ''}${esc(ctx.labelOf(q))} ${restNote(q)}</div>
        <div class="dk-vs">${vs(q)}</div></div>
      <div class="dk-go">
        <button type="button" class="icon-btn ${q.pinned ? 'on' : ''}" data-action="desk-pin" data-key="${esc(q.key)}" title="${q.pinned ? '取消優先' : '設為優先（排到最前面）'}" aria-label="優先">📌</button>
        ${empties.map((n) => `<button type="button" class="btn small" data-action="desk-assign" data-table="${n}" data-key="${esc(q.key)}" ${q.blocked ? 'disabled' : ''}>${n} 號桌</button>`).join('')}
      </div></li>`;

  return `
    <section class="card dk-controls">
      <div class="dk-ctl-row">
        <label>球桌數<select data-change="desk-set" data-field="tables">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${desk.tables === n ? 'selected' : ''}>${n} 張</option>`).join('')}</select></label>
        <label>${who}休息<select data-change="desk-set" data-field="rest">
          <option value="0" ${desk.rest === 0 ? 'selected' : ''}>不限制</option>
          <option value="1" ${desk.rest === 1 ? 'selected' : ''}>至少隔 1 輪</option>
          <option value="2" ${desk.rest === 2 ? 'selected' : ''}>至少隔 2 輪</option></select></label>
        <label class="dk-check"><input type="checkbox" data-change="desk-set" data-field="auto" ${desk.auto ? 'checked' : ''}> 打完自動補上建議場次</label>
        <div class="dk-ctl-btns">
          <button type="button" class="btn primary" data-action="desk-fill" ${empties.length && queue.some((q) => !q.blocked) ? '' : 'disabled'}>一鍵排滿空桌</button>
          <button type="button" class="btn" data-action="desk-reset">重設桌況</button>
        </div>
      </div>
      <p class="note">系統會優先排「休息最久、輪次最前面」的場次，並避開正在比賽的${who}；標「⚠ 剛打完」的場次表示沒有更適合的選擇，要不要上桌由你決定，也可以按 📌 優先、或自己點「N 號桌」指定。</p>
    </section>
    <div class="dk-layout">
      <section class="card dk-planbox"><h3>球桌</h3>${plan}</section>
      <section class="card dk-queue">
        <div class="dk-qhead"><h3>待賽清單 <small>${shown.length} 場</small></h3>
          ${multi ? `<div class="hub-filter dk-filter">${chip('all', '全部')}${Object.keys(ctx.divisions).map((d) => chip(d, ctx.divisionLabel(d))).join('')}</div>` : ''}</div>
        ${shown.length ? `<ol class="dk-list">${shown.map(row).join('')}</ol>` : '<p class="note">目前沒有可以開打的場次。</p>'}
      </section>
    </div>`;
}

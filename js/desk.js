// 記分台：球桌場地圖 ＋ 待賽清單。
// 兩個組別的場次放在同一份清單，系統依「選手剛打完幾場」建議下一場；主辦可以隨時手動調整。
// 桌況（哪張桌子在打哪一場、出賽紀錄）只存在記分的這台電腦（localStorage），不寫進資料庫。

export const DESK_DEFAULT = { tables: 5, rest: 1, auto: true, assign: {}, history: [], pins: [], filter: 'all' };
export const keyOf = (div, stage, code) => `${div}|${stage}|${code}`;

export function loadDesk(raw) {
  try {
    const d = JSON.parse(raw);
    return { ...DESK_DEFAULT, ...d, assign: { ...(d.assign || {}) }, history: [...(d.history || [])], pins: [...(d.pins || [])] };
  } catch {
    return { ...DESK_DEFAULT, assign: {}, history: [], pins: [] };
  }
}

// 所有對戰（任何狀態）：key → { key, div, stage, code, info, round }
export function collectInfos(views) {
  const map = new Map();
  for (const v of Object.values(views)) {
    for (const [stage, res] of [['main', v.res], ['group', v.groupRes], ['final', v.finalRes]]) {
      if (!res) continue;
      for (const [code, info] of res) {
        const key = keyOf(v.div, stage, code);
        map.set(key, { key, div: v.div, stage, code, info, round: info.match?.round ?? 1 });
      }
    }
  }
  return map;
}

const playable = (it) => (it.info.state === 'ready' || it.info.state === 'live') && it.info.p1 && it.info.p2;

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
    if (it) { ids.add(it.info.p1); ids.add(it.info.p2); }
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
    if (!playable(it)) continue;
    for (const id of [it.info.p1, it.info.p2]) load.set(id, (load.get(id) || 0) + 1);
  }
  const list = [...infos.values()].filter((it) => playable(it) && !onTable.has(it.key)).map((it, idx) => {
    const g1 = gapOf(desk, it.info.p1);
    const g2 = gapOf(desk, it.info.p2);
    const gap = Math.min(g1, g2);
    const tired = [];
    if (g1 < need) tired.push(it.info.p1);
    if (g2 < need) tired.push(it.info.p2);
    return { ...it, idx, gap, load: (load.get(it.info.p1) || 0) + (load.get(it.info.p2) || 0), tired, ok: tired.length === 0, blocked: busy.has(it.info.p1) || busy.has(it.info.p2), pinned: desk.pins.includes(it.key) };
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
  desk.history.push({ key: item.key, ids: [item.info.p1, item.info.p2] });
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
    if (!it || it.info.state === 'done' || it.info.state === 'bye') { delete desk.assign[n]; freed.push(Number(n)); }
  }
  for (const n of Object.keys(desk.assign)) if (Number(n) > desk.tables) delete desk.assign[n];
  desk.pins = desk.pins.filter((k) => infos.has(k) && playable(infos.get(k)));
  return freed;
}

// ---------------------------------------------------------------- 畫面

// ctx：{ esc, nameOf, avatarOf, playerById, divisionLabel, labelOf(item), scoreOf(item), isBusy }
export function renderDesk(desk, infos, ctx) {
  const { esc } = ctx;
  const queue = buildQueue(desk, infos);
  const empties = emptyTables(desk);
  const shown = queue.filter((q) => desk.filter === 'all' || q.div === desk.filter);
  const vs = (it) => `<span class="dk-p">${ctx.avatarOf(ctx.playerById(it.info.p1), 'xs')}<b>${esc(ctx.nameOf(it.info.p1))}</b></span><i>vs</i><span class="dk-p">${ctx.avatarOf(ctx.playerById(it.info.p2), 'xs')}<b>${esc(ctx.nameOf(it.info.p2))}</b></span>`;

  const tableCard = (n) => {
    const key = desk.assign[n];
    const it = key && infos.get(key);
    if (!it) {
      return `<div class="dk-table empty t${n}"><div class="dk-th"><b>${n} 號桌</b><span class="dk-tag idle">空桌</span></div>
        <p class="dk-empty">目前沒有比賽</p>
        <button type="button" class="btn small primary" data-action="desk-fill-one" data-table="${n}" ${queue.some((q) => !q.blocked) ? '' : 'disabled'}>排入建議場次</button></div>`;
    }
    const score = ctx.scoreOf(it);
    return `<div class="dk-table busy t${n}"><div class="dk-th"><b>${n} 號桌</b><span class="dk-tag ${it.div}">${esc(ctx.divisionLabel(it.div))}</span></div>
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
    if (q.blocked) return '<span class="dk-rest wait">選手比賽中</span>';
    if (q.ok) return `<span class="dk-rest ok">${q.gap >= 999 ? '尚未出賽' : `休息 ${q.gap} 場`}</span>`;
    return `<span class="dk-rest warn">⚠ ${q.tired.map((id) => esc(ctx.nameOf(id))).join('、')} 剛打完</span>`;
  };
  const row = (q, i) => `<li class="dk-item ${q.blocked ? 'blocked' : ''} ${q.pinned ? 'pinned' : ''}">
      <span class="dk-no">${i + 1}</span>
      <div class="dk-body"><div class="dk-meta"><span class="dk-tag ${q.div}">${esc(ctx.divisionLabel(q.div))}</span> ${esc(ctx.labelOf(q))} ${restNote(q)}</div>
        <div class="dk-vs">${vs(q)}</div></div>
      <div class="dk-go">
        <button type="button" class="icon-btn ${q.pinned ? 'on' : ''}" data-action="desk-pin" data-key="${esc(q.key)}" title="${q.pinned ? '取消優先' : '設為優先（排到最前面）'}" aria-label="優先">📌</button>
        ${empties.map((n) => `<button type="button" class="btn small" data-action="desk-assign" data-table="${n}" data-key="${esc(q.key)}" ${q.blocked ? 'disabled' : ''}>${n} 號桌</button>`).join('')}
      </div></li>`;

  return `
    <section class="card dk-controls">
      <div class="dk-ctl-row">
        <label>球桌數<select data-change="desk-set" data-field="tables">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${desk.tables === n ? 'selected' : ''}>${n} 張</option>`).join('')}</select></label>
        <label>選手休息<select data-change="desk-set" data-field="rest">
          <option value="0" ${desk.rest === 0 ? 'selected' : ''}>不限制</option>
          <option value="1" ${desk.rest === 1 ? 'selected' : ''}>至少隔 1 輪</option>
          <option value="2" ${desk.rest === 2 ? 'selected' : ''}>至少隔 2 輪</option></select></label>
        <label class="dk-check"><input type="checkbox" data-change="desk-set" data-field="auto" ${desk.auto ? 'checked' : ''}> 打完自動補上建議場次</label>
        <div class="dk-ctl-btns">
          <button type="button" class="btn primary" data-action="desk-fill" ${empties.length && queue.some((q) => !q.blocked) ? '' : 'disabled'}>一鍵排滿空桌</button>
          <button type="button" class="btn" data-action="desk-reset">重設桌況</button>
        </div>
      </div>
      <p class="note">系統會優先排「休息最久、輪次最前面」的場次，並避開正在比賽的選手；標「⚠ 剛打完」的場次表示沒有更適合的選擇，要不要上桌由你決定，也可以按 📌 優先、或自己點「N 號桌」指定。</p>
    </section>
    <div class="dk-layout">
      <section class="card dk-planbox"><h3>球桌</h3>${plan}</section>
      <section class="card dk-queue">
        <div class="dk-qhead"><h3>待賽清單 <small>${shown.length} 場</small></h3>
          <div class="hub-filter dk-filter">${chip('all', '全部')}${Object.keys(ctx.divisions).map((d) => chip(d, ctx.divisionLabel(d))).join('')}</div></div>
        ${shown.length ? `<ol class="dk-list">${shown.map(row).join('')}</ol>` : '<p class="note">目前沒有可以開打的場次。預賽打完並產生總決賽後，總決賽的場次會出現在這裡。</p>'}
      </section>
    </div>`;
}

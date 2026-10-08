import { ORGANIZER_EMAIL } from './config.js';
import { createBackend, isConfigured, DEFAULT_DIVISION } from './backend.js';
import {
  DIVISIONS, FORMATS, FINAL_FORMATS, BEST_OF, GROUP_LABELS,
  gameWinner, isStandardGame, matchOutcome, nextPow2,
  buildSingle, buildDouble, buildGroups, buildSuper, knockoutSeeds,
  resolveStage, dependentsOf, standings, resultsFrom, roundLabel, knockoutPlacings,
} from './bracket.js';
import { exportExcel, lineReport } from './export.js';

const demo = new URLSearchParams(location.search).has('demo');
const store = {
  get(key, fallback) { try { return localStorage.getItem(`sg_${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`sg_${key}`, value); } catch { /* 忽略 */ } },
};

const state = {
  loaded: false,
  error: null,
  busy: false,
  live: false,
  settings: { title: '桌球單打賽' },
  divisions: { competitive: { id: 'competitive', ...DEFAULT_DIVISION }, fun: { id: 'fun', ...DEFAULT_DIVISION } },
  players: [],
  matches: [],
  user: null,
  view: store.get('view', 'results') === 'admin' ? 'admin' : 'results',
  division: DIVISIONS[store.get('division')] ? store.get('division') : 'competitive',
  stageTab: store.get('stageTab', 'group'),
  me: store.get('me', ''),
};

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastEl = document.getElementById('toast');
let backend;

// ---------------------------------------------------------------- 小工具

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isOrganizer = () => !!state.user && (state.user.email || '').toLowerCase() === ORGANIZER_EMAIL.toLowerCase();
const playerById = (id) => state.players.find((p) => p.id === id);
const nameOf = (id) => playerById(id)?.name ?? '（已刪除）';
const playersOf = (div) => state.players.filter((p) => p.division === div).sort((a, b) => a.seed - b.seed || a.created_at.localeCompare(b.created_at));
const matchesOf = (div, stage) => state.matches.filter((m) => m.division === div && m.stage === stage);
// 每場局數：總決賽可另外設定，沒設定就跟預賽相同
const bestOfFor = (cfg, stage) => (stage === 'final' && cfg.final_best_of ? cfg.final_best_of : cfg.best_of);

let toastTimer;
function toast(message, kind = 'info') {
  toastEl.textContent = message;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 3400);
}

async function run(task, successMessage) {
  if (state.busy) return false;
  state.busy = true;
  render();
  try {
    await task();
    if (successMessage) toast(successMessage, 'ok');
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || '操作失敗，請再試一次', 'error');
    return false;
  } finally {
    state.busy = false;
    await reload();
  }
}

// ---------------------------------------------------------------- 每個組別的推算資料

function divisionView(div) {
  const cfg = state.divisions[div];
  const players = playersOf(div);
  const main = matchesOf(div, 'main');
  const group = matchesOf(div, 'group');
  const final = matchesOf(div, 'final');
  const v = { div, cfg, players, main, group, final, phase: 'setup' };
  const playerIds = players.map((p) => p.id);

  if (main.length) {
    v.phase = 'main';
    v.res = resolveStage(main, cfg.best_of);
    v.size = nextPow2(main.filter((m) => /^W1-/.test(m.code)).length * 2);
    v.placings = knockoutPlacings(v.res, cfg.format);
  }
  if (group.length) {
    v.phase = final.length ? 'final' : 'group';
    v.groupRes = resolveStage(group, cfg.best_of);
    const labels = [...new Set(group.map((m) => m.grp))].sort();
    v.groups = labels.map((g) => {
      const ids = playerIds.filter((id) => playerById(id).grp === g);
      const results = resultsFrom(v.groupRes).filter((r) => ids.includes(r.a));
      const rows = standings(ids, results, (id) => playerById(id)?.draw_group ?? null);
      const done = group.filter((m) => m.grp === g).every((m) => ['done', 'bye'].includes(v.groupRes.get(m.code).state));
      return { grp: g, ids, rows, done, matches: group.filter((m) => m.grp === g) };
    });
    v.groupsDone = v.groups.every((g) => g.done);
    // 有「需抽籤但還沒抽」的同分會影響總決賽時，先不能產生總決賽：
    // ・同分橫跨晉級線（決定誰晉級）→ 一定要抽
    // ・總決賽是單淘汰時，晉級者之間的名次決定種子與半區 → 晉級名額內的同分也要抽
    const k = cfg.advance_count;
    v.unresolved = v.groups.filter((g) => {
      const clusters = new Map();
      for (const r of g.rows) {
        if (!r.drawTied) continue;
        if (!clusters.has(r.tieGroup)) clusters.set(r.tieGroup, []);
        clusters.get(r.tieGroup).push(r);
      }
      return [...clusters.values()].some((c) => {
        if (!c.some((r) => r.draw == null)) return false;
        const inside = c.some((r) => r.rank <= k);
        const outside = c.some((r) => r.rank > k);
        return (inside && outside) || (inside && cfg.final_format === 'single');
      });
    }).map((g) => g.grp);
  }
  if (final.length) {
    v.finalRes = resolveStage(final, bestOfFor(cfg, 'final'));
    if (cfg.final_format === 'super') {
      const qualIds = [...new Set(final.flatMap((m) => [m.src1.seed, m.src2.seed]))];
      // 晉級者之間：同組的預賽成績＋總決賽的新對戰
      const carried = resultsFrom(v.groupRes).filter((r) => qualIds.includes(r.a) && qualIds.includes(r.b));
      v.superRows = standings(qualIds, [...carried, ...resultsFrom(v.finalRes)], (id) => playerById(id)?.draw_final ?? null);
      v.carried = carried;
      v.superDone = [...v.finalRes.values()].every((r) => ['done', 'bye'].includes(r.state));
      // 還有「需抽籤但還沒抽」的同分時，名次未定，先不公布名次
      v.superAwaitingDraw = v.superDone && v.superRows.some((r) => r.drawTied && r.draw == null);
      v.placings = v.superDone && !v.superAwaitingDraw ? v.superRows.map((r) => ({ place: r.rank, id: r.id })) : [];
    } else {
      v.size = nextPow2(final.filter((m) => /^W1-/.test(m.code)).length * 2);
      v.placings = knockoutPlacings(v.finalRes, 'single');
    }
  }
  const allRes = [v.res, v.groupRes, v.finalRes].filter(Boolean).flatMap((r) => [...r.values()]);
  v.total = allRes.filter((r) => r.state !== 'bye').length;
  v.done = allRes.filter((r) => r.state === 'done').length;
  return v;
}

// ---------------------------------------------------------------- 資料載入與即時同步

let reloadTimer;
const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 250); };

async function reload() {
  try {
    Object.assign(state, await backend.load(), { loaded: true, error: null });
  } catch (err) {
    console.error(err);
    state.error = err.message || '資料讀取失敗';
  }
  requestRender();
}

let pendingRender = false;
const isEditing = () => {
  const el = document.activeElement;
  return !!el && app.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};
function requestRender() {
  if (isEditing()) pendingRender = true;
  else render();
}
app.addEventListener('focusout', () => {
  setTimeout(() => { if (pendingRender && !isEditing()) { pendingRender = false; render(); } }, 0);
});

// ---------------------------------------------------------------- 畫面元件

const emptyState = (text) => `<div class="empty"><span aria-hidden="true">🏓</span><p>${esc(text)}</p></div>`;

function renderHeader() {
  return `
    <header class="topbar">
      <div class="container topbar-inner">
        <div class="brand">
          <span class="brand-icon" aria-hidden="true">🏓</span>
          <div>
            <h1>${esc(state.settings.title)}</h1>
            ${state.live
              ? `<p class="live"><span class="dot" aria-hidden="true"></span>即時更新中</p>`
              : `<p class="live off"><span class="dot" aria-hidden="true"></span>重新連線中，每 15 秒自動更新</p>`}
          </div>
        </div>
        ${isOrganizer() ? `<button class="btn small" data-action="logout">登出主辦</button>` : ''}
      </div>
      <nav class="container viewtabs two" aria-label="功能">
        <button class="viewtab ${state.view === 'results' ? 'on' : ''}" data-action="view" data-view="results" aria-pressed="${state.view === 'results'}">賽程與成績</button>
        <button class="viewtab ${state.view === 'admin' ? 'on' : ''}" data-action="view" data-view="admin" aria-pressed="${state.view === 'admin'}">主辦管理</button>
      </nav>
    </header>`;
}

function renderDivisionTabs() {
  return `
    <nav class="tabs" aria-label="組別">
      ${Object.entries(DIVISIONS).map(([key, label]) => {
        const cfg = state.divisions[key];
        return `<button class="tab ${state.division === key ? 'on' : ''}" data-action="division" data-division="${key}" aria-pressed="${state.division === key}">
          ${label}<span class="count">${playersOf(key).length} 人・${FORMATS[cfg.format]}</span></button>`;
      }).join('')}
    </nav>`;
}

// 一場對戰的方框（籤表、分組賽、總決賽都用這個）
function matchBox(info, { label = '', admin = false, stage }) {
  const m = info.match;
  const me = state.me;
  const out = matchOutcome(info.state === 'done' || info.state === 'live' ? m.games : [], bestOfFor(state.divisions[m.division], m.stage));
  const line = (pid, isBye, side) => {
    const won = info.state === 'done' && info.winner === pid;
    const text = pid ? esc(nameOf(pid)) : isBye ? '<i>輪空</i>' : '<i>待定</i>';
    const score = info.state === 'done' || info.state === 'live' ? (side === 1 ? out.w1 : out.w2) : '';
    return `<div class="mline ${won ? 'win' : ''} ${pid && pid === me ? 'me' : ''}"><span class="pname">${text}</span><span class="pscore">${score}</span></div>`;
  };
  const bye1 = info.bye1 || (info.state === 'bye' && !info.p1);
  const bye2 = info.bye2 || (info.state === 'bye' && !info.p2);
  const clickable = admin && info.p1 && info.p2 && info.state !== 'bye';
  const games = (info.state === 'done' || info.state === 'live') && m.games.length
    ? `<div class="mgames">${m.games.map((g) => `<span class="${gameWinner(g) === 1 ? 'g1' : 'g2'}">${g[0]}:${g[1]}</span>`).join('')}</div>` : '';
  const badge = { done: '', live: '<span class="mbadge live">進行中</span>', ready: '', pending: '', bye: '<span class="mbadge">輪空晉級</span>' }[info.state] || '';
  const tag = clickable ? 'button' : 'div';
  const attrs = clickable ? `type="button" data-action="score" data-stage="${stage}" data-code="${esc(m.code)}" aria-label="登錄比分：${esc(nameOf(info.p1))} 對 ${esc(nameOf(info.p2))}"` : '';
  return `
    <${tag} class="mbox ${info.state} ${clickable ? 'clickable' : ''} ${me && (info.p1 === me || info.p2 === me) ? 'mine' : ''}" ${attrs}>
      ${label || badge ? `<div class="mhead"><span>${esc(label)}</span>${badge}</div>` : ''}
      ${line(info.p1, bye1, 1)}
      ${line(info.p2, bye2, 2)}
      ${games}
      ${info.stale ? '<div class="mwarn">⚠️ 選手已變更，原比分失效，請重新登錄</div>' : ''}
      ${clickable ? `<div class="mhint">${info.state === 'done' ? '點此修改比分' : '點此登錄比分'}</div>` : ''}
    </${tag}>`;
}

// 淘汰賽籤表：每一輪一欄
function bracketColumns(res, codes, size, { admin, stage, labelFor }) {
  const rounds = new Map();
  for (const code of codes) {
    const r = Number(code.match(/^[WL](\d+)-/)[1]);
    if (!rounds.has(r)) rounds.set(r, []);
    rounds.get(r).push(code);
  }
  return `
    <div class="bracket">
      ${[...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => `
        <div class="bcol">
          <h4>${esc(labelFor(list[0]))}</h4>
          <div class="bmatches">
            ${list.sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1])).map((c) => matchBox(res.get(c), { admin, stage })).join('')}
          </div>
        </div>`).join('')}
    </div>`;
}

function renderKnockout(res, size, format, { admin, stage }) {
  const codes = [...res.keys()];
  if (format === 'double') {
    return `
      <h3 class="section-title">勝部</h3>
      ${bracketColumns(res, codes.filter((c) => c.startsWith('W')), size, { admin, stage, labelFor: (c) => roundLabel(c, size).replace(/^(決賽|準決賽|\d+ 強)$/, (s) => (/^\d/.test(s) ? `勝部 ${s}` : `勝部${s}`)) })}
      <h3 class="section-title">敗部</h3>
      ${bracketColumns(res, codes.filter((c) => c.startsWith('L')), size, { admin, stage, labelFor: (c) => roundLabel(c, size) })}
      <h3 class="section-title">冠軍戰</h3>
      <div class="single-box">${matchBox(res.get('GF'), { label: '冠軍戰（一場定勝負）', admin, stage })}</div>`;
  }
  return `
    ${bracketColumns(res, codes.filter((c) => c.startsWith('W')), size, { admin, stage, labelFor: (c) => roundLabel(c, size) })}
    ${res.get('T') ? `<h3 class="section-title">季軍賽</h3><div class="single-box">${matchBox(res.get('T'), { label: '季軍賽', admin, stage })}</div>` : ''}`;
}

// complete = 這個階段的比賽都打完了；還沒打完時同分只是暫時的，不需要抽籤
function standingsTable(rows, { qualify = 0, admin = false, drawField, complete = true }) {
  const needDraw = complete && rows.some((r) => r.drawTied && r.draw == null);
  rows = rows.map((r) => (complete || !r.drawTied ? r : { ...r, drawTied: false, basis: '戰績相同（暫定）' }));
  return `
    ${needDraw && admin ? `<div class="banner warn">有選手戰績完全相同，請抽籤後在「抽籤」欄填入順位。</div>` : ''}
    <div class="table-wrap">
      <table class="rank-table">
        <thead><tr><th>名次</th><th class="left">選手</th><th>勝</th><th>敗</th><th>局數</th><th class="hide-sm">得失分</th><th class="left hide-sm">判定依據</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const basis = r.drawTied && r.draw == null ? `${r.basis}（未抽籤）` : r.basis;
            const draw = r.drawTied && admin
              ? `<label class="draw">抽籤 <select data-change="draw" data-field="${drawField}" data-id="${r.id}" aria-label="${esc(nameOf(r.id))} 抽籤順位">
                   <option value="">—</option>${rows.map((_, i) => `<option value="${i + 1}" ${r.draw === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}
                 </select></label>` : '';
            return `<tr class="${r.id === state.me ? 'mine' : ''} ${complete && qualify && r.rank <= qualify && r.played ? 'qualified' : ''}">
              <td class="rank">${r.rank}</td>
              <td class="left"><div class="team">${esc(nameOf(r.id))}${complete && qualify && r.rank <= qualify && r.played ? ' <span class="qtag">晉級</span>' : ''}</div><div class="basis show-sm">${esc(basis)}</div>${draw}</td>
              <td>${r.wins}</td><td>${r.losses}</td><td class="nowrap">${r.gamesWon}:${r.gamesLost}</td>
              <td class="hide-sm nowrap">${r.pointsWon}:${r.pointsLost}</td><td class="left hide-sm basis">${esc(basis)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function placingsCard(v) {
  if (v.superAwaitingDraw) {
    return `<section class="card placings"><h3>🏆 ${DIVISIONS[v.div]} 名次</h3><p class="note">總決賽已全部打完，但有選手戰績完全相同，等待主辦單位抽籤後公布最終名次。</p></section>`;
  }
  if (!v.placings?.length) return '';
  const medal = ['', '🥇', '🥈', '🥉', '4️⃣'];
  return `
    <section class="card placings">
      <h3>🏆 ${DIVISIONS[v.div]} 名次</h3>
      <ol>${v.placings.filter((p) => p.place <= 8).map((p) => `<li class="${p.id === state.me ? 'mine' : ''}"><span class="medal">${medal[p.place] || p.place}</span>${esc(nameOf(p.id))}</li>`).join('')}</ol>
    </section>`;
}

function formatSummary(v) {
  const c = v.cfg;
  const base = `${FORMATS[c.format]}・每場${BEST_OF[c.best_of]}`;
  if (c.format !== 'groups') return base + (c.format === 'single' ? '・加打季軍賽' : '・冠軍戰一場定勝負');
  const finalBo = bestOfFor(c, 'final');
  const finalText = finalBo !== c.best_of ? `，總決賽每場${BEST_OF[finalBo]}` : '';
  return `${base}・分 ${c.group_count} 組，每組取前 ${c.advance_count} 名進入總決賽（${FINAL_FORMATS[c.final_format]}${finalText}）`;
}

// 總決賽每場局數的選單（空白 = 與預賽相同）
const finalBestOfSelect = (c) => `
  <label>總決賽每場局數<select data-change="div-setting" data-field="final_best_of">
    <option value="" ${!c.final_best_of ? 'selected' : ''}>與預賽相同（${BEST_OF[c.best_of]}）</option>
    ${Object.entries(BEST_OF).map(([k, l]) => `<option value="${k}" ${c.final_best_of === Number(k) ? 'selected' : ''}>${l}</option>`).join('')}
  </select></label>`;

// 我的下一場
function myBanner(v) {
  if (!state.me || playerById(state.me)?.division !== v.div) return '';
  const all = [v.res, v.groupRes, v.finalRes].filter(Boolean).flatMap((r) => [...r.values()]);
  const mine = all.filter((r) => r.p1 === state.me || r.p2 === state.me);
  const next = mine.find((r) => r.state === 'ready' || r.state === 'live');
  if (next) return `<div class="banner info">你的下一場：對上 <b>${esc(nameOf(next.p1 === state.me ? next.p2 : next.p1))}</b></div>`;
  const place = v.placings?.find((p) => p.id === state.me);
  if (place) return `<div class="banner info">你的最終名次：第 <b>${place.place}</b> 名</div>`;
  if (mine.some((r) => r.state === 'pending')) return `<div class="banner info">等待上一輪結果，你的下一場對手還沒產生。</div>`;
  return '';
}

// 給選手看的賽制與名次規則（內容依主辦設定自動調整）
function rulesCard(v) {
  const c = v.cfg;
  const bo = (stage) => BEST_OF[bestOfFor(c, stage)];
  const knockoutBasics = `
    <li><b>種子與輪空：</b>人數不是 2 的次方（4、8、16…）時會有輪空，輪空優先給前段種子，直接晉級下一輪。1、2 號種子分在不同半區，最快在決賽才會相遇。</li>`;
  const tie = `
    <ol class="rule-steps">
      <li><b>勝場數</b>多者，名次在前。</li>
      <li><b>兩人勝場數相同：</b>看這兩人之間比賽的勝負，勝者在前。</li>
      <li><b>三人以上勝場數相同（互咬）：</b>只計算這幾位<u>彼此之間</u>的比賽，依序比：
        <ol class="rule-sub">
          <li><b>場數勝率</b>＝勝場數 ÷ 敗場數</li>
          <li><b>局數勝率</b>＝勝局數 ÷ 敗局數</li>
          <li><b>分數勝率</b>＝總得分 ÷ 總失分</li>
        </ol>
        比較過程中，若只剩<b>兩人</b>數據相同，改看這兩人之間比賽的勝負。</li>
      <li><b>以上全部相同：</b>由主辦單位抽籤決定。</li>
    </ol>
    <div class="rule-example"><b>例：</b>甲、乙、丙三人都是 1 勝 1 敗：甲 2:0 勝乙、乙 2:1 勝丙、丙 2:1 勝甲，場數勝率相同。接著比三人彼此之間的局數勝率：甲 3:2、丙 3:3、乙 2:3，名次就是 甲 → 丙 → 乙。</div>`;

  let body;
  if (c.format === 'single') {
    body = `
      <ol class="rule-steps">
        <li><b>淘汰方式：</b>每場${bo('main')}，輸一場即淘汰，勝者晉級下一輪。</li>
        ${knockoutBasics}
        <li><b>名次：</b>決賽勝者為冠軍、敗者為亞軍；準決賽的兩位敗者再打<b>季軍賽</b>，勝者第 3 名、敗者第 4 名。</li>
      </ol>`;
  } else if (c.format === 'double') {
    body = `
      <ol class="rule-steps">
        <li><b>淘汰方式：</b>每場${bo('main')}。每位選手要<b>輸兩場</b>才淘汰。</li>
        <li><b>勝部與敗部：</b>所有人從<b>勝部</b>開始；在勝部輸第一場的選手掉到<b>敗部</b>繼續比賽，在敗部再輸一場就淘汰。</li>
        ${knockoutBasics}
        <li><b>冠軍戰：</b>勝部冠軍對敗部冠軍，<b>一場定勝負</b>（勝部冠軍輸了也不再加賽）。</li>
        <li><b>名次：</b>冠軍戰勝者第 1 名、敗者第 2 名；敗部決賽的敗者第 3 名，敗部準決賽的敗者第 4 名。</li>
      </ol>`;
  } else {
    body = `
      <ol class="rule-steps">
        <li><b>預賽分組：</b>依種子順序<b>蛇形</b>分成 ${c.group_count} 組（1 號種子在 A 組、2 號在 B 組…，下一輪反過來排），讓各組實力平均。</li>
        <li><b>預賽：</b>組內單循環，每場${bo('group')}，每組前 <b>${c.advance_count}</b> 名晉級總決賽。</li>
        <li><b>總決賽：</b>每場${bo('final')}。${c.final_format === 'super'
          ? '晉級選手打<b>超級循環賽</b>：預賽<b>同組</b>的選手<b>不再重打</b>，直接帶入預賽兩人之間的對戰成績；只打<b>不同組</b>之間的比賽，依下方循環賽名次規則排出最終名次。'
          : '晉級選手進行<b>單淘汰賽</b>：各組第 1 名為前段種子、優先輪空；<b>同組第 1、2 名分在不同半區</b>，最快在決賽（或季軍賽）才會再遇到；同組其他晉級選手也盡量安排越晚相遇，不會在第一輪碰頭。準決賽兩位敗者加打<b>季軍賽</b>。'}</li>
      </ol>
      <p><b>循環賽名次判定</b>（預賽各組${c.final_format === 'super' ? '、超級循環賽' : ''}適用）：</p>
      ${tie}
      <p class="rule-foot">＊各組還沒打完時，排名表的名次為暫定；整組打完後若仍有戰績完全相同，才由主辦抽籤。勝率計算時，沒有輸過（分母為 0）視為最高。</p>`;
  }
  return `
    <section class="rules card" id="rules" aria-labelledby="rules-title">
      <h3 id="rules-title">📖 ${DIVISIONS[v.div]} 賽制與名次規則</h3>
      <p><b>賽制：</b>${esc(formatSummary(v))}。</p>
      <p><b>計分：</b>每局 11 分制，10:10 後需領先 2 分才獲勝。</p>
      ${body}
      <p class="rule-foot">＊比賽結果以主辦單位登錄的比分為準，頁面會即時更新。</p>
    </section>`;
}

// ---------------------------------------------------------------- 主畫面：賽程與成績

function renderCompetition(v, { admin }) {
  if (v.phase === 'setup') {
    return `${emptyState(admin ? '尚未產生賽程，請在上方設定賽制與選手名單。' : '主辦單位尚未產生賽程，以下為目前預定的賽制與規則。')}
      ${!admin && v.players.length ? `<section class="card"><h3>報名選手（${v.players.length}）</h3><p>${v.players.map((p) => esc(p.name)).join('、')}</p></section>` : ''}
      ${admin ? '' : rulesCard(v)}`;
  }
  const pct = v.total ? Math.round((v.done / v.total) * 100) : 0;
  const picker = `
    <div class="picker">
      <label for="me">我的名字</label>
      <select id="me" data-change="me"><option value="">（不指定）</option>
        ${v.players.map((p) => `<option value="${p.id}" ${p.id === state.me ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
    </div>`;
  let body = '';
  if (v.phase === 'main') {
    body = renderKnockout(v.res, v.size, v.cfg.format, { admin, stage: 'main' });
  } else {
    const tab = v.phase === 'final' ? state.stageTab : 'group';
    const tabs = v.phase === 'final' ? `
      <nav class="subtabs two" aria-label="階段">
        <button class="subtab ${tab === 'group' ? 'on' : ''}" data-action="stage-tab" data-tab="group">預賽（分組循環）</button>
        <button class="subtab ${tab === 'final' ? 'on' : ''}" data-action="stage-tab" data-tab="final">總決賽</button>
      </nav>` : '';
    if (tab === 'group') {
      body = tabs + v.groups.map((g) => `
        <section class="card group-card">
          <h3>${g.grp} 組 ${g.done ? '<span class="chip ok">已完賽</span>' : ''}</h3>
          ${standingsTable(g.rows, { qualify: v.cfg.advance_count, admin, drawField: 'draw_group', complete: g.done })}
          <div class="match-list">${g.matches.sort((a, b) => a.round - b.round || a.idx - b.idx).map((m) => matchBox(v.groupRes.get(m.code), { label: `第 ${m.round} 輪`, admin, stage: 'group' })).join('')}</div>
        </section>`).join('');
    } else if (v.cfg.final_format === 'super') {
      body = tabs + `
        <section class="card">
          <h3>總決賽（超級循環賽）排名</h3>
          ${standingsTable(v.superRows, { admin, drawField: 'draw_final', complete: v.superDone })}
          <p class="note">預賽同組選手不再重打，已帶入預賽的 ${v.carried.length} 場對戰成績。</p>
        </section>
        <h3 class="section-title">總決賽對戰</h3>
        <div class="match-list">${v.final.sort((a, b) => a.round - b.round || a.idx - b.idx).map((m) => matchBox(v.finalRes.get(m.code), { label: `第 ${m.round} 輪`, admin, stage: 'final' })).join('')}</div>`;
    } else {
      body = tabs + renderKnockout(v.finalRes, v.size, 'single', { admin, stage: 'final' });
    }
  }
  return `
    <section class="card status">
      <p class="status-text"><b>${esc(formatSummary(v))}</b>　<a class="rules-link" href="#rules">📖 賽制與名次規則</a></p>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="賽事進度"><div class="progress-bar" style="width:${pct}%"></div></div>
      <p class="status-text">賽事進度 <b>${v.done}</b> / ${v.total} 場（${pct}%）${v.phase === 'group' ? '・預賽進行中' : v.phase === 'final' ? '・總決賽' : ''}</p>
      ${picker}
    </section>
    ${myBanner(v)}
    ${placingsCard(v)}
    ${body}
    ${rulesCard(v)}`;
}

// ---------------------------------------------------------------- 主辦管理

function renderAdminLogin() {
  return `
    <section class="card narrow">
      <h2>主辦單位登入</h2>
      <form class="form" data-form="login">
        <label>帳號<input name="email" type="email" required autocomplete="username" value="${esc(ORGANIZER_EMAIL)}"></label>
        <label>密碼<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn primary" ${state.busy ? 'disabled' : ''}>登入</button>
      </form>
      ${demo ? `<p class="note">示範模式主辦密碼：<b>${esc(backend.demoPassword)}</b></p>` : ''}
    </section>`;
}

function renderSetup(v) {
  const c = v.cfg;
  const n = v.players.length;
  const busy = state.busy ? 'disabled' : '';
  const groupInfo = (() => {
    if (c.format !== 'groups') return '';
    const G = c.group_count;
    if (n < G * 2) return `<p class="banner warn">${n} 人分 ${G} 組，每組不到 2 人，請減少組數或增加選手。</p>`;
    const min = Math.floor(n / G);
    const max = Math.ceil(n / G);
    const sizeText = min === max ? `每組 ${min} 人` : `每組 ${min}～${max} 人`;
    const warn = c.advance_count >= min ? `<p class="banner warn">每組最少 ${min} 人，晉級名額需少於 ${min}。</p>` : '';
    return `<p class="note">${n} 人分 ${G} 組，${sizeText}；共 ${G * c.advance_count} 人進入總決賽。</p>${warn}`;
  })();
  return `
    <section class="card">
      <h3>① 賽制設定</h3>
      <div class="grid-form form">
        <label>賽制<select data-change="div-setting" data-field="format">
          ${Object.entries(FORMATS).map(([k, l]) => `<option value="${k}" ${c.format === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <label>${c.format === 'groups' ? '預賽每場局數' : '每場局數'}<select data-change="div-setting" data-field="best_of">
          ${Object.entries(BEST_OF).map(([k, l]) => `<option value="${k}" ${c.best_of === Number(k) ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        ${c.format === 'groups' ? `
          <label>組數<input type="number" min="2" max="32" value="${c.group_count}" data-change="div-setting" data-field="group_count"></label>
          <label>每組晉級人數<input type="number" min="1" max="8" value="${c.advance_count}" data-change="div-setting" data-field="advance_count"></label>
          <label>總決賽<select data-change="div-setting" data-field="final_format">
            ${Object.entries(FINAL_FORMATS).map(([k, l]) => `<option value="${k}" ${c.final_format === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
          ${finalBestOfSelect(c)}` : ''}
      </div>
      ${groupInfo}
      <p class="note">${{ single: '單淘汰：輸一場即淘汰，加打季軍賽。', double: '雙淘汰：輸兩場才淘汰，冠軍戰一場定勝負（至少 3 人）。', groups: '分組循環：依種子蛇形分組，組內單循環，各組前幾名進入總決賽。' }[c.format]}</p>
    </section>

    <section class="card">
      <div class="section-head">
        <h3>② 選手與種子順序 <span class="count">${n} 人</span></h3>
        <button class="btn small" data-action="shuffle" ${busy || n < 2 ? 'disabled' : ''}>🎲 隨機抽籤</button>
      </div>
      <p class="note">順序就是種子序：第 1 位為 1 號種子。淘汰賽的輪空優先給前段種子；分組時依此順序蛇形分配。</p>
      <ol class="seed-list">
        ${v.players.map((p, i) => `
          <li>
            <span class="seed-no">${i + 1}</span><span class="seed-name">${esc(p.name)}</span>
            <button class="icon-btn" data-action="move" data-id="${p.id}" data-dir="-1" aria-label="${esc(p.name)} 往前" ${busy || i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-btn" data-action="move" data-id="${p.id}" data-dir="1" aria-label="${esc(p.name)} 往後" ${busy || i === n - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon-btn del" data-action="delete-player" data-id="${p.id}" aria-label="刪除 ${esc(p.name)}" ${busy}>✕</button>
          </li>`).join('') || '<li class="note">尚無選手</li>'}
      </ol>
      <form class="inline-form" data-form="add-player">
        <input name="name" maxlength="20" placeholder="新增選手姓名" required autocomplete="off" aria-label="新增選手姓名">
        <button class="btn" ${busy}>新增</button>
      </form>
      <form class="form" data-form="bulk-players">
        <label>批次匯入（每行一位，或用逗號、頓號分開；依序排在最後）
          <textarea name="text" rows="3" placeholder="王小明&#10;李大華、陳志強"></textarea></label>
        <button class="btn" ${busy}>匯入</button>
      </form>
    </section>

    <section class="card">
      <h3>③ 產生賽程</h3>
      <p class="note">產生後即鎖定賽制與名單；如需修改，可在「重設賽程」後重新產生。</p>
      <button class="btn primary" data-action="generate" ${busy}>產生${FORMATS[c.format]}賽程</button>
    </section>`;
}

function renderAdmin() {
  if (!isOrganizer()) return renderAdminLogin();
  const v = divisionView(state.division);
  const busy = state.busy ? 'disabled' : '';
  const actions = [];
  if (v.phase === 'group') {
    actions.push(`<button class="btn primary" data-action="make-final" ${busy || !v.groupsDone ? 'disabled' : ''}>產生總決賽（${FINAL_FORMATS[v.cfg.final_format]}）</button>`);
  }
  if (v.phase === 'final') actions.push(`<button class="btn" data-action="reset-final" ${busy}>取消總決賽，回到預賽</button>`);
  if (v.phase !== 'setup') actions.push(`<button class="btn danger" data-action="reset" ${busy}>重設本組賽程</button>`);
  const minGroup = v.groups ? Math.min(...v.groups.map((g) => g.ids.length)) : 0;
  // 總決賽產生前，晉級人數與總決賽賽制都還可以調整
  const finalSettings = v.phase === 'group' ? `
    <div class="grid-form form">
      <label>每組晉級人數<select data-change="div-setting" data-field="advance_count">
        ${Array.from({ length: Math.max(1, minGroup - 1) }, (_, i) => i + 1).map((k) => `<option value="${k}" ${v.cfg.advance_count === k ? 'selected' : ''}>前 ${k} 名</option>`).join('')}
      </select></label>
      <label>總決賽<select data-change="div-setting" data-field="final_format">
        ${Object.entries(FINAL_FORMATS).map(([k, l]) => `<option value="${k}" ${v.cfg.final_format === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      ${finalBestOfSelect(v.cfg)}
    </div>` : '';
  const groupHint = v.phase === 'group'
    ? (!v.groupsDone ? '<p class="note">預賽全部打完後，才能產生總決賽。產生前仍可調整晉級人數與總決賽賽制。</p>'
      : v.unresolved.length ? `<p class="banner warn">${v.unresolved.join('、')} 組有戰績完全相同的選手${v.cfg.final_format === 'single' ? '，會影響晉級或總決賽的種子位置' : '，會影響誰晉級'}，請先在該組排名表填入抽籤順位。</p>` : '')
    : '';
  return `
    ${renderDivisionTabs()}
    ${v.phase === 'setup' ? renderSetup(v) : `
      <section class="card">
        <h3>${DIVISIONS[v.div]} 賽程管理</h3>
        <p class="note">點選對戰方框即可登錄或修改比分。</p>
        ${finalSettings}
        ${groupHint}
        <div class="actions wrap">${actions.join('')}</div>
      </section>
      ${renderCompetition(v, { admin: true })}`}
    <section class="card">
      <h3>大會設定與匯出</h3>
      <form class="inline-form" data-form="title">
        <input name="title" maxlength="40" value="${esc(state.settings.title)}" aria-label="網站標題" required>
        <button class="btn" ${busy}>更新標題</button>
      </form>
      <div class="actions wrap">
        <button class="btn" data-action="export-excel">匯出 Excel</button>
        <button class="btn" data-action="copy-report">複製 LINE 成績</button>
        <button class="btn" data-action="copy-link">複製網站網址</button>
        <button class="btn" data-action="change-password">變更主辦密碼</button>
        <button class="btn danger" data-action="wipe" ${busy}>清除全部資料</button>
      </div>
    </section>`;
}

function render() {
  if (!state.loaded) {
    app.innerHTML = state.error
      ? `<div class="center-card"><h2>無法讀取資料</h2><p>${esc(state.error)}</p><button class="btn primary" data-action="retry">重新載入</button></div>`
      : `<div class="center-card"><div class="spinner" aria-hidden="true"></div><p>載入中…</p></div>`;
    return;
  }
  app.innerHTML = `
    ${renderHeader()}
    <main class="container">
      ${state.error ? `<div class="banner error">⚠️ 與資料庫連線異常：${esc(state.error)}（畫面可能不是最新）</div>` : ''}
      ${demo ? `<div class="banner demo">🧪 示範模式：資料只存在這個分頁，重新整理就會還原。</div>` : ''}
      ${state.view === 'admin' ? renderAdmin() : `${renderDivisionTabs()}${renderCompetition(divisionView(state.division), { admin: false })}`}
    </main>`;
}

// ---------------------------------------------------------------- 對話框

function openModal(html, onReady) {
  const previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const backdrop = modalRoot.querySelector('.backdrop');
  const close = () => {
    modalRoot.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    if (previousFocus?.focus) previousFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) close(); });
  onReady(modalRoot.querySelector('.modal'), close);
  if (!modalRoot.contains(document.activeElement)) modalRoot.querySelector('input, button:not([data-close])')?.focus();
}

function openScoreModal(div, stage, code) {
  const v = divisionView(div);
  const res = stage === 'main' ? v.res : stage === 'group' ? v.groupRes : v.finalRes;
  const info = res.get(code);
  const stageMatches = stage === 'main' ? v.main : stage === 'group' ? v.group : v.final;
  const bestOf = bestOfFor(v.cfg, stage);
  const need = Math.ceil(bestOf / 2);
  const n1 = nameOf(info.p1);
  const n2 = nameOf(info.p2);
  const saved = info.stale ? [] : info.match.games;
  const cell = (i, side) => `<input class="pt-input" type="number" inputmode="numeric" min="0" max="99" data-game="${i}" data-side="${side}" value="${saved[i] ? saved[i][side] : ''}" aria-label="第 ${i + 1} 局 ${esc(side ? n2 : n1)} 得分">`;
  const label = info.match.grp ? `${info.match.grp} 組 第 ${info.match.round} 輪` : /^S-/.test(code) ? '總決賽' : roundLabel(code, stage === 'main' ? v.size : v.size);

  openModal(
    `<h2>${esc(label)}</h2>
     <div class="score-head"><span>${esc(n1)}</span><b class="score-total"></b><span>${esc(n2)}</span></div>
     <p class="score-hint">${BEST_OF[bestOf]}：輸入每局兩人得分，先贏 ${need} 局者勝。</p>
     <div class="game-rows">
       ${Array.from({ length: bestOf }, (_, i) => `
         <div class="game-row" data-row="${i}"><span class="game-label">第 ${i + 1} 局</span>${cell(i, 0)}<span class="colon">:</span>${cell(i, 1)}<span class="row-note"></span></div>`).join('')}
     </div>
     <p class="score-result"></p>
     <div class="modal-actions">
       <button type="button" class="btn" data-clear>清除比分</button>
       <button type="button" class="btn" data-close>取消</button>
       <button type="button" class="btn primary" data-save>儲存</button>
     </div>`,
    (modal, close) => {
      const rowsEl = [...modal.querySelectorAll('.game-row')];
      const evaluate = () => {
        const games = [];
        let problem = null;
        let w1 = 0;
        let w2 = 0;
        for (let i = 0; i < bestOf && w1 < need && w2 < need; i++) {
          const [x, y] = [...rowsEl[i].querySelectorAll('.pt-input')].map((el) => el.value);
          if (x === '' && y === '') break;
          const a = Number(x);
          const b = Number(y);
          if (x === '' || y === '' || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) {
            problem = { i, message: x !== '' && y !== '' && a === b ? '同分無法判定勝方' : '請填完兩人得分' };
            break;
          }
          games.push([a, b]);
          if (a > b) w1++; else w2++;
        }
        return { games, problem, w1, w2, decided: w1 >= need || w2 >= need };
      };
      const draw = () => {
        const ev = evaluate();
        const visible = Math.min(bestOf, ev.decided ? ev.games.length : ev.games.length + 1);
        rowsEl.forEach((row, i) => {
          row.hidden = i >= visible;
          const g = ev.games[i];
          row.classList.toggle('w1', !!g && g[0] > g[1]);
          row.classList.toggle('w2', !!g && g[1] > g[0]);
          const note = row.querySelector('.row-note');
          if (ev.problem?.i === i) { note.textContent = ev.problem.message; note.className = 'row-note bad'; }
          else if (g && !isStandardGame(g[0], g[1])) { note.textContent = '非 11 分制比分，請再確認'; note.className = 'row-note warn'; }
          else { note.textContent = ''; note.className = 'row-note'; }
        });
        modal.querySelector('.score-total').textContent = `${ev.w1} : ${ev.w2}`;
        modal.querySelector('.score-result').innerHTML = ev.decided
          ? `🏆 勝方：<b>${esc(ev.w1 > ev.w2 ? n1 : n2)}</b>` : ev.games.length ? '比賽進行中，可先儲存目前比分。' : '';
      };
      modal.querySelector('.game-rows').addEventListener('input', draw);
      modal.querySelector('.game-rows').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.target.matches('.pt-input')) return;
        e.preventDefault();
        const inputs = [...modal.querySelectorAll('.game-row:not([hidden]) .pt-input')];
        (inputs[inputs.indexOf(e.target) + 1] || modal.querySelector('[data-save]')).focus();
      });
      modal.querySelector('[data-clear]').addEventListener('click', () => {
        modal.querySelectorAll('.pt-input').forEach((el) => { el.value = ''; });
        draw();
      });
      modal.querySelector('[data-save]').addEventListener('click', async () => {
        const ev = evaluate();
        if (ev.problem) {
          modal.querySelector('.score-result').innerHTML = `<span class="error">第 ${ev.problem.i + 1} 局：${ev.problem.message}</span>`;
          return;
        }
        // 勝負改變時，若後續對戰已經有比分，要先清除後續比分（避免名次錯亂）
        const oldWinner = info.state === 'done' ? info.winner : null;
        const newWinner = ev.decided ? (ev.w1 > ev.w2 ? info.p1 : info.p2) : null;
        if (oldWinner !== newWinner) {
          const blocked = dependentsOf(stageMatches, code).filter((m) => (m.games || []).length);
          if (blocked.length) {
            const names = blocked.map((m) => roundLabel(m.code, v.size) || m.code).join('、');
            modal.querySelector('.score-result').innerHTML = `<span class="error">後續的「${esc(names)}」已有比分，請先清除那幾場的比分，再修改這一場的勝負。</span>`;
            return;
          }
        }
        close();
        await run(() => backend.updateMatch(info.match.id, { games: ev.games, p1_id: info.p1, p2_id: info.p2 }), '比分已儲存');
      });
      draw();
      [...modal.querySelectorAll('.game-row:not([hidden]) .pt-input')].find((el) => el.value === '')?.focus();
    }
  );
}

function openPasswordModal() {
  openModal(
    `<h2>變更主辦密碼</h2>
     <form>
       <label>目前密碼<input name="current" type="password" required autocomplete="current-password"></label>
       <label>新密碼（至少 6 個字元）<input name="next" type="password" required minlength="6" autocomplete="new-password"></label>
       <label>再輸入一次新密碼<input name="confirm" type="password" required minlength="6" autocomplete="new-password"></label>
       <p class="error" hidden></p>
       <div class="modal-actions"><button type="button" class="btn" data-close>取消</button><button class="btn primary">更新密碼</button></div>
     </form>`,
    (modal, close) => {
      const form = modal.querySelector('form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = form.querySelector('.error');
        const fail = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
        if (form.next.value !== form.confirm.value) return fail('兩次輸入的新密碼不一樣');
        try {
          await backend.changePassword(state.user.email, form.current.value, form.next.value);
          close();
          toast('密碼已更新（雙打、團體賽系統也是同一個帳號）', 'ok');
        } catch (err) { fail(err.message); }
      });
    }
  );
}

// ---------------------------------------------------------------- 操作

const copyText = async (text, okMessage) => {
  try { await navigator.clipboard.writeText(text); toast(okMessage, 'ok'); }
  catch { prompt('請複製以下內容：', text); }
};

function generate() {
  const v = divisionView(state.division);
  const c = v.cfg;
  const ids = v.players.map((p) => p.id);
  const n = ids.length;
  let rows;
  let playerPatch = [];
  if (c.format === 'single') {
    if (n < 2) return toast('單淘汰至少需要 2 位選手', 'error');
    rows = buildSingle(ids, 'main');
  } else if (c.format === 'double') {
    if (n < 3) return toast('雙淘汰至少需要 3 位選手', 'error');
    rows = buildDouble(ids, 'main');
  } else {
    const G = c.group_count;
    const min = Math.floor(n / G);
    if (n < G * 2) return toast(`${n} 人分 ${G} 組，每組不到 2 人，請減少組數`, 'error');
    if (c.advance_count >= min) return toast(`每組最少 ${min} 人，晉級名額需少於 ${min}`, 'error');
    const built = buildGroups(ids, G);
    rows = built.rows;
    playerPatch = v.players.map((p) => ({ ...p, grp: built.assign[p.id], draw_group: null, draw_final: null }));
  }
  const real = rows.length;
  if (!confirm(`以「${formatSummary(v)}」產生 ${DIVISIONS[v.div]} 賽程？\n${n} 位選手，共 ${real} 個對戰位置（含輪空）。\n\n產生後賽制與名單會鎖定。`)) return;
  run(async () => {
    if (playerPatch.length) await backend.savePlayers(playerPatch);
    await backend.createMatches(rows.map((r) => ({ ...r, division: v.div, grp: r.grp ?? null })));
  }, '賽程已產生');
}

function makeFinal() {
  const v = divisionView(state.division);
  if (v.unresolved.length) return toast(`${v.unresolved.join('、')} 組需要先抽籤`, 'error');
  const k = v.cfg.advance_count;
  const groupRanks = v.groups.map((g) => ({ grp: g.grp, ids: g.rows.slice(0, k).map((r) => r.id) }));
  const qualifiers = groupRanks.flatMap((g) => g.ids.map((id) => ({ id, grp: g.grp })));
  let rows;
  if (v.cfg.final_format === 'super') {
    rows = buildSuper(knockoutSeeds(groupRanks, k).map((id) => qualifiers.find((q) => q.id === id)));
  } else {
    rows = buildSingle(knockoutSeeds(groupRanks, k), 'final');
  }
  const list = groupRanks.map((g) => `${g.grp} 組：${g.ids.map(nameOf).join('、')}`).join('\n');
  if (!confirm(`晉級總決賽（${FINAL_FORMATS[v.cfg.final_format]}）：\n${list}\n\n確定產生總決賽？`)) return;
  run(async () => {
    await backend.createMatches(rows.map((r) => ({ ...r, division: v.div, grp: null })));
    state.stageTab = 'final';
    store.set('stageTab', 'final');
  }, '總決賽已產生');
}

function parseNames(text) {
  return [...new Set(text.split(/[\r\n,，、]+/).map((s) => s.trim()).filter(Boolean))];
}

const actions = {
  retry: () => { state.error = null; render(); reload(); },
  view: ({ view }) => { state.view = view; store.set('view', view); render(); window.scrollTo(0, 0); },
  division: ({ division }) => { state.division = division; store.set('division', division); render(); },
  'stage-tab': ({ tab }) => { state.stageTab = tab; store.set('stageTab', tab); render(); },
  logout: async () => { await backend.signOut(); toast('已登出'); },
  score: ({ stage, code }) => openScoreModal(state.division, stage, code),
  shuffle: () => {
    if (!confirm('隨機打亂種子順序？')) return;
    const list = playersOf(state.division);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    run(() => backend.savePlayers(list.map((p, i) => ({ ...p, seed: i + 1 }))), '已隨機抽籤');
  },
  move: ({ id, dir }) => {
    const list = playersOf(state.division);
    const i = list.findIndex((p) => p.id === id);
    const j = i + Number(dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    run(() => backend.savePlayers(list.map((p, k) => ({ ...p, seed: k + 1 }))));
  },
  'delete-player': ({ id }) => {
    if (!confirm(`確定刪除選手「${nameOf(id)}」？`)) return;
    run(() => backend.deletePlayer(id), '已刪除');
  },
  generate,
  'make-final': makeFinal,
  'reset-final': () => {
    if (!confirm('取消總決賽會刪除總決賽的所有對戰與比分，回到預賽。確定嗎？')) return;
    run(async () => {
      await backend.deleteMatches(state.division, ['final']);
      await backend.savePlayers(playersOf(state.division).map((p) => ({ ...p, draw_final: null })));
    }, '已取消總決賽');
  },
  reset: () => {
    if (!confirm(`重設「${DIVISIONS[state.division]}」會刪除所有對戰與比分（保留選手名單）。確定嗎？`)) return;
    if (!confirm('再次確認：比分刪除後無法復原。')) return;
    run(async () => {
      await backend.deleteMatches(state.division, ['main', 'group', 'final']);
      await backend.savePlayers(playersOf(state.division).map((p) => ({ ...p, grp: null, draw_group: null, draw_final: null })));
    }, '已重設賽程');
  },
  'export-excel': () => {
    try { exportExcel(exportCtx()); } catch (err) { toast(err.message, 'error'); }
  },
  'copy-report': () => copyText(lineReport(exportCtx()), '已複製成績，可以貼到 LINE'),
  'copy-link': () => copyText(location.origin + location.pathname + (demo ? '?demo' : ''), '網址已複製'),
  'change-password': () => (backend.isDemo ? toast('示範模式無法變更密碼') : openPasswordModal()),
  wipe: () => {
    if (!confirm('⚠️ 這會刪除兩個組別的「所有選手、對戰與比分」。確定嗎？')) return;
    if (!confirm('最後確認：全部資料將無法復原。')) return;
    run(() => backend.wipe(), '全部資料已清除');
  },
};

function exportCtx() {
  return {
    title: state.settings.title,
    divisions: Object.keys(DIVISIONS).map((div) => {
      const v = divisionView(div);
      const toRow = (r) => [r.rank, nameOf(r.id), r.wins, r.losses, `${r.gamesWon}:${r.gamesLost}`, `${r.pointsWon}:${r.pointsLost}`, r.basis];
      const tables = [
        ...(v.groups || []).map((g) => ({ title: `預賽 ${g.grp} 組`, rows: g.rows.map(toRow) })),
        ...(v.superRows ? [{ title: '總決賽（超級循環賽）', rows: v.superRows.map(toRow) }] : []),
      ];
      const matches = [];
      const push = (res, stageName, labelOf) => {
        for (const r of res ? res.values() : []) {
          if (r.state !== 'done' && r.state !== 'live') continue;
          const o = matchOutcome(r.match.games, bestOfFor(v.cfg, r.match.stage));
          matches.push({ stage: stageName, round: labelOf(r.match), p1: nameOf(r.p1), p2: nameOf(r.p2), score: `${o.w1} : ${o.w2}`,
            games: r.match.games.map((g) => `${g[0]}:${g[1]}`).join('、'), winner: r.winner ? nameOf(r.winner) : '（進行中）' });
        }
      };
      push(v.res, FORMATS[v.cfg.format], (m) => roundLabel(m.code, v.size));
      push(v.groupRes, '預賽', (m) => `${m.grp} 組 第 ${m.round} 輪`);
      push(v.finalRes, '總決賽', (m) => (/^S-/.test(m.code) ? `第 ${m.round} 輪` : roundLabel(m.code, v.size)));
      return {
        label: DIVISIONS[div],
        formatLabel: formatSummary(v),
        placings: (v.placings || []).map((p) => ({ place: p.place, name: nameOf(p.id) })),
        tables,
        matches,
      };
    }),
  };
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el.dataset, el);
});

app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const kind = el.dataset.change;
  if (kind === 'me') {
    state.me = el.value;
    store.set('me', el.value);
    render();
  } else if (kind === 'div-setting') {
    const field = el.dataset.field;
    const value = field === 'final_best_of'
      ? (el.value ? Number(el.value) : null)
      : ['best_of', 'group_count', 'advance_count'].includes(field) ? Number(el.value) : el.value;
    if (field === 'group_count' && !(value >= 2 && value <= 32)) return toast('組數需為 2～32', 'error');
    if (field === 'advance_count' && !(value >= 1 && value <= 8)) return toast('晉級人數需為 1～8', 'error');
    el.blur();
    run(() => backend.updateDivision(state.division, { [field]: value }));
  } else if (kind === 'draw') {
    const p = playerById(el.dataset.id);
    const value = el.value ? Number(el.value) : null;
    el.blur();
    run(() => backend.savePlayers([{ ...p, [el.dataset.field]: value }]), '抽籤順位已更新');
  }
});

app.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'login') {
    await run(() => backend.signIn(form.email.value.trim(), form.password.value), '已登入主辦模式');
  } else if (kind === 'add-player' || kind === 'bulk-players') {
    const names = kind === 'add-player' ? [form.name.value.trim()].filter(Boolean) : parseNames(form.text.value);
    const list = playersOf(state.division);
    const existing = new Set(list.map((p) => p.name));
    const fresh = names.filter((n) => !existing.has(n) && n.length <= 20);
    if (!fresh.length) return toast(names.length ? '這些選手已經在名單中' : '請輸入選手姓名', 'error');
    const start = Math.max(0, ...list.map((p) => p.seed)) + 1;
    if (await run(() => backend.addPlayers(fresh.map((name, i) => ({ division: state.division, name, seed: start + i }))), `已新增 ${fresh.length} 位選手`)) form.reset();
  } else if (kind === 'title') {
    await run(() => backend.updateSettings({ title: form.title.value.trim() }), '標題已更新');
  }
});

// ---------------------------------------------------------------- 啟動

async function init() {
  if (!demo && !isConfigured()) {
    app.innerHTML = `<div class="center-card"><h2>🏓 尚未連接資料庫</h2><p>請在 <code>js/config.js</code> 填入 Supabase 設定。</p><p><a class="btn primary" href="?demo">先試用示範模式</a></p></div>`;
    return;
  }
  render();
  try {
    backend = await createBackend({ demo });
  } catch (err) {
    console.error(err);
    state.error = '無法載入資料庫模組，請檢查網路連線後重新整理。';
    render();
    return;
  }
  state.user = await backend.getUser();
  backend.onAuthChange((user) => { state.user = user; render(); });
  await reload();
  backend.subscribe(scheduleReload, (status) => {
    const live = status === 'SUBSCRIBED';
    if (live) scheduleReload();
    if (live !== state.live) { state.live = live; requestRender(); }
  });
  const poll = () => {
    if (!document.hidden) scheduleReload();
    setTimeout(poll, state.live ? 60000 : 15000);
  };
  setTimeout(poll, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleReload(); });
}

init();

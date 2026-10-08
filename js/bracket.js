// 單打賽制核心：賽程產生、晉級推算（含輪空）、循環賽名次、最終名次。
// 對戰的選手不直接存，而是由「來源」推算：{seed: 選手id|null}、{win: 代號}、{lose: 代號}。
// 這樣上游比分修改時，下游的對戰選手會自動跟著更新。

export const DIVISIONS = { competitive: '競賽組', fun: '歡樂成長組' };
export const FORMATS = { single: '單淘汰賽', double: '雙淘汰賽', groups: '分組循環賽' };
export const FINAL_FORMATS = { single: '單淘汰賽', super: '超級循環賽' };
export const BEST_OF = { 3: '三局兩勝', 5: '五局三勝', 7: '七局四勝' };
export const GROUP_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ---------------------------------------------------------------- 比分

export const gameWinner = (g) => (Array.isArray(g) && g[0] !== g[1] ? (g[0] > g[1] ? 1 : 2) : 0);
export const isStandardGame = (a, b) => {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi === 11 ? lo <= 9 : hi > 11 && hi - lo === 2;
};
export function matchOutcome(games, bestOf) {
  const need = Math.ceil(Number(bestOf) / 2);
  let w1 = 0;
  let w2 = 0;
  for (const g of games || []) {
    const w = gameWinner(g);
    if (w === 1) w1++;
    else if (w === 2) w2++;
  }
  return { w1, w2, winnerSide: w1 >= need ? 1 : w2 >= need ? 2 : 0 };
}

// ---------------------------------------------------------------- 籤表

export const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

// 標準種子位置：S=8 → [1,8,4,5,2,7,3,6]，1、2 號種子在不同半區，最晚在決賽相遇
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2;
    order = order.flatMap((s) => [s, m + 1 - s]);
  }
  return order;
}

const seedSrc = (seeds, s) => ({ seed: seeds[s - 1] ?? null });

// 單淘汰：W{輪}-{序}；有準決賽時加季軍賽 T
export function buildSingle(seeds, stage, { thirdPlace = true } = {}) {
  const size = nextPow2(seeds.length);
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const rows = [];
  for (let i = 0; i < size / 2; i++) {
    rows.push({ stage, code: `W1-${i}`, round: 1, idx: i, src1: seedSrc(seeds, order[2 * i]), src2: seedSrc(seeds, order[2 * i + 1]) });
  }
  for (let r = 2; r <= rounds; r++) {
    for (let i = 0; i < size / 2 ** r; i++) {
      rows.push({ stage, code: `W${r}-${i}`, round: r, idx: i, src1: { win: `W${r - 1}-${2 * i}` }, src2: { win: `W${r - 1}-${2 * i + 1}` } });
    }
  }
  if (thirdPlace && rounds >= 2) {
    rows.push({ stage, code: 'T', round: rounds, idx: 1, src1: { lose: `W${rounds - 1}-0` }, src2: { lose: `W${rounds - 1}-1` } });
  }
  return rows;
}

// 雙淘汰：勝部 W、敗部 L、冠軍戰 GF（只打一場）
export function buildDouble(seeds, stage) {
  const rows = buildSingle(seeds, stage, { thirdPlace: false });
  const size = nextPow2(seeds.length);
  const R = Math.log2(size);
  // 敗部第 1 輪：勝部第 1 輪的敗者兩兩對戰
  for (let i = 0; i < size / 4; i++) {
    rows.push({ stage, code: `L1-${i}`, round: 1, idx: i, src1: { lose: `W1-${2 * i}` }, src2: { lose: `W1-${2 * i + 1}` } });
  }
  for (let k = 1; k <= R - 1; k++) {
    // 偶數輪：敗部晉級者 vs 勝部第 k+1 輪的敗者（隔輪反向排列，避免太早重複對戰）
    const n = size / 2 ** (k + 1);
    for (let i = 0; i < n; i++) {
      const j = k % 2 === 1 ? n - 1 - i : i;
      rows.push({ stage, code: `L${2 * k}-${i}`, round: 2 * k, idx: i, src1: { win: `L${2 * k - 1}-${i}` }, src2: { lose: `W${k + 1}-${j}` } });
    }
    // 奇數輪：敗部晉級者兩兩對戰
    if (k <= R - 2) {
      for (let i = 0; i < n / 2; i++) {
        rows.push({ stage, code: `L${2 * k + 1}-${i}`, round: 2 * k + 1, idx: i, src1: { win: `L${2 * k}-${2 * i}` }, src2: { win: `L${2 * k}-${2 * i + 1}` } });
      }
    }
  }
  rows.push({ stage, code: 'GF', round: 1, idx: 0, src1: { win: `W${R}-0` }, src2: { win: `L${2 * R - 2}-0` } });
  return rows;
}

// 循環賽順序（環狀輪轉法），奇數人自動輪空
export function roundRobin(ids) {
  const slots = [...ids];
  if (slots.length % 2) slots.push(null);
  const n = slots.length;
  const pairs = [];
  for (let round = 1; round < n; round++) {
    for (let i = 0; i < n / 2; i++) {
      const a = slots[i];
      const b = slots[n - 1 - i];
      if (a && b) pairs.push({ round, a, b });
    }
    slots.splice(1, 0, slots.pop());
  }
  return pairs;
}

// 分組：依種子順序蛇形分配（A B C D D C B A …），各組實力平均
export function assignGroups(seededIds, groupCount) {
  const assign = {};
  seededIds.forEach((id, i) => {
    const row = Math.floor(i / groupCount);
    const col = i % groupCount;
    assign[id] = GROUP_LABELS[row % 2 === 0 ? col : groupCount - 1 - col];
  });
  return assign;
}

export function buildGroups(seededIds, groupCount) {
  const assign = assignGroups(seededIds, groupCount);
  const rows = [];
  for (const g of GROUP_LABELS.slice(0, groupCount)) {
    const members = seededIds.filter((id) => assign[id] === g);
    roundRobin(members).forEach((p, i) => rows.push({
      stage: 'group', code: `G${g}-${i}`, grp: g, round: p.round, idx: i, src1: { seed: p.a }, src2: { seed: p.b },
    }));
  }
  return { assign, rows };
}

// 超級循環賽：晉級者之間只打「不同組」的對戰；同組對戰沿用預賽成績
export function buildSuper(qualifiers) {
  const rows = [];
  roundRobin(qualifiers.map((q) => q.id))
    .filter((p) => qualifiers.find((q) => q.id === p.a).grp !== qualifiers.find((q) => q.id === p.b).grp)
    .forEach((p, i) => rows.push({ stage: 'final', code: `S-${i}`, round: p.round, idx: i, src1: { seed: p.a }, src2: { seed: p.b } }));
  return rows;
}

// 預賽晉級者的淘汰賽種子：各組第 1 名為前段種子，同組晉級者盡量分在不同半區
export function knockoutSeeds(groupRanks, advance) {
  // groupRanks: [{ grp, ids: [第1名, 第2名, …] }]
  const seeds = [];
  for (let t = 0; t < advance; t++) {
    const tier = t % 2 === 0 ? groupRanks : [...groupRanks].reverse();
    for (const g of tier) if (g.ids[t]) seeds.push({ id: g.ids[t], grp: g.grp, tier: t });
  }
  // 同組選手越晚相遇越好：在第 r 輪相遇的代價為 4^(總輪數 − r)，第 1 輪相遇代價最高、決賽最低。
  // 只在「同一名次層」之間交換（各組第 1 名永遠是前段種子），反覆交換直到代價不再下降。
  const size = nextPow2(seeds.length);
  const R = Math.log2(size);
  const order = seedOrder(size);
  const posOf = (i) => order.indexOf(i + 1); // 第 i 位種子在籤表的位置
  const meetRound = (i, j) => Math.floor(Math.log2(posOf(i) ^ posOf(j))) + 1;
  // 最優先：各組第 1、2 名分在不同半區（決賽前不會相遇）
  const cost = () => {
    let c = 0;
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        if (seeds[i].grp !== seeds[j].grp) continue;
        const r = meetRound(i, j);
        c += 4 ** (R - r);
        if (seeds[i].tier + seeds[j].tier === 1 && r < R) c += 4 ** (R + 2);
      }
    }
    return c;
  };
  let best = cost();
  for (let pass = 0; pass < 50 && best > 0; pass++) {
    let improved = false;
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        if (seeds[i].tier !== seeds[j].tier || seeds[i].tier === 0) continue;
        [seeds[i], seeds[j]] = [seeds[j], seeds[i]];
        const c = cost();
        if (c < best) { best = c; improved = true; }
        else [seeds[i], seeds[j]] = [seeds[j], seeds[i]];
      }
    }
    if (!improved) break;
  }
  return seeds.map((s) => s.id);
}

// ---------------------------------------------------------------- 推算每場對戰的狀態

// 回傳 Map(代號 → { state, p1, p2, winner, loser, stale, match })
// state：bye（輪空直接晉級）、pending（等上一輪）、ready（可比賽）、live（進行中）、done（已完賽）
export function resolveStage(matches, bestOf) {
  const byCode = new Map(matches.map((m) => [m.code, m]));
  const memo = new Map();
  const slot = (src) => {
    if (!src) return { tbd: true };
    if ('seed' in src) return src.seed ? { player: src.seed } : { bye: true };
    const ref = info(src.win || src.lose);
    if (!ref) return { bye: true };
    if (ref.state === 'bye') return src.win && ref.winner ? { player: ref.winner } : { bye: true };
    if (ref.state === 'done') return { player: src.win ? ref.winner : ref.loser };
    return { tbd: true };
  };
  function info(code) {
    if (memo.has(code)) return memo.get(code);
    const m = byCode.get(code);
    if (!m) return null;
    memo.set(code, { state: 'pending' });
    const a = slot(m.src1);
    const b = slot(m.src2);
    let r;
    if (a.bye && b.bye) r = { state: 'bye', winner: null };
    else if (a.bye && b.player) r = { state: 'bye', winner: b.player, p2: b.player };
    else if (b.bye && a.player) r = { state: 'bye', winner: a.player, p1: a.player };
    else if (a.player && b.player) {
      const fresh = m.p1_id === a.player && m.p2_id === b.player;
      const hasGames = (m.games || []).length > 0;
      const out = matchOutcome(fresh ? m.games : [], bestOf);
      if (out.winnerSide) {
        r = { state: 'done', winner: out.winnerSide === 1 ? a.player : b.player, loser: out.winnerSide === 1 ? b.player : a.player };
      } else {
        r = { state: hasGames && fresh ? 'live' : 'ready', stale: hasGames && !fresh };
      }
      r.p1 = a.player;
      r.p2 = b.player;
    } else {
      r = { state: 'pending', p1: a.player || null, p2: b.player || null, bye1: !!a.bye, bye2: !!b.bye };
    }
    r.match = m;
    memo.set(code, r);
    return r;
  }
  for (const m of matches) info(m.code);
  return memo;
}

// 有哪些對戰的選手來自這一場（修改比分前檢查用）
export const dependentsOf = (matches, code) =>
  matches.filter((m) => [m.src1, m.src2].some((s) => s && (s.win === code || s.lose === code)));

// ---------------------------------------------------------------- 循環賽名次
// 勝場數 → 兩人同勝場看對戰勝負 → 三人以上只計彼此對戰：場數、局數、分數勝率（剩兩人時看對戰勝負）→ 抽籤

const ratio = (won, lost) => (lost === 0 ? (won > 0 ? Infinity : 1) : won / lost);
const STEPS = [
  { key: 'matchRatio', label: '互咬・場數勝率' },
  { key: 'gameRatio', label: '互咬・局數勝率' },
  { key: 'pointRatio', label: '互咬・分數勝率' },
];

// results：[{ a, b, games, winner }]（已完賽，a、b 為選手 id，games 以 a 的角度記錄）
export function standings(ids, results, drawOf = () => null) {
  const tallyOf = (id, list) => {
    const t = { mw: 0, ml: 0, gw: 0, gl: 0, pw: 0, pl: 0 };
    for (const r of list) {
      const side = r.a === id ? 0 : r.b === id ? 1 : -1;
      if (side < 0) continue;
      if (r.winner === id) t.mw++;
      else t.ml++;
      for (const g of r.games) {
        if (g[side] > g[1 - side]) t.gw++;
        else t.gl++;
        t.pw += Number(g[side]) || 0;
        t.pl += Number(g[1 - side]) || 0;
      }
    }
    return t;
  };
  const rows = ids.map((id) => {
    const t = tallyOf(id, results);
    return { id, played: t.mw + t.ml, wins: t.mw, losses: t.ml, gamesWon: t.gw, gamesLost: t.gl, pointsWon: t.pw, pointsLost: t.pl,
      gameRatio: ratio(t.gw, t.gl), pointRatio: ratio(t.pw, t.pl), basis: '', drawTied: false, draw: drawOf(id) };
  });
  if (!results.length) {
    rows.forEach((r, i) => { r.rank = i + 1; r.basis = '尚未有比賽結果'; });
    return rows;
  }
  const h2h = (a, b) => results.find((r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id));
  let tieCount = 0;
  const drawSort = (list) => [...list].sort((x, y) => (x.draw ?? 999) - (y.draw ?? 999));

  const pair = ([a, b]) => {
    const m = h2h(a, b);
    if (m) {
      a.basis = b.basis = '兩人對戰勝負';
      return m.winner === a.id ? [a, b] : [b, a];
    }
    for (const [key, label] of [['gameRatio', '全賽局數勝率'], ['pointRatio', '全賽分數勝率']]) {
      if (a[key] !== b[key]) {
        a.basis = b.basis = label;
        return a[key] > b[key] ? [a, b] : [b, a];
      }
    }
    a.drawTied = b.drawTied = true;
    a.tieGroup = b.tieGroup = ++tieCount;
    a.basis = b.basis = '戰績相同・抽籤';
    return drawSort([a, b]);
  };
  const splitByStep = (members, step, mutual) => {
    if (members.length === 1) return members;
    if (members.length === 2 && step > 0) {
      const m = h2h(members[0], members[1]);
      if (m) {
        members.forEach((s) => { s.basis = '互咬・剩兩人看對戰勝負'; });
        return m.winner === members[0].id ? members : [members[1], members[0]];
      }
    }
    if (step >= STEPS.length) {
      const id = ++tieCount; // 同一群完全相同、需要一起抽籤的選手
      members.forEach((s) => { s.drawTied = true; s.tieGroup = id; s.basis = '戰績相同・抽籤'; });
      return drawSort(members);
    }
    const { key, label } = STEPS[step];
    const values = [...new Set(members.map((s) => mutual.get(s.id)[key]))].sort((x, y) => y - x);
    const out = [];
    for (const v of values) {
      const part = members.filter((s) => mutual.get(s.id)[key] === v);
      if (part.length === 1) part[0].basis = label;
      out.push(...splitByStep(part, step + 1, mutual));
    }
    return out;
  };
  const group = (members) => {
    const set = new Set(members.map((s) => s.id));
    const inner = results.filter((r) => set.has(r.a) && set.has(r.b));
    const mutual = new Map(members.map((s) => {
      const t = tallyOf(s.id, inner);
      return [s.id, { matchRatio: ratio(t.mw, t.ml), gameRatio: ratio(t.gw, t.gl), pointRatio: ratio(t.pw, t.pl) }];
    }));
    return splitByStep(members, 0, mutual);
  };

  const byWins = new Map();
  for (const r of rows) {
    if (!byWins.has(r.wins)) byWins.set(r.wins, []);
    byWins.get(r.wins).push(r);
  }
  const ordered = [];
  for (const w of [...byWins.keys()].sort((x, y) => y - x)) {
    const g = byWins.get(w);
    if (g.length === 1) { g[0].basis = '勝場數'; ordered.push(g[0]); }
    else if (g.length === 2) ordered.push(...pair(g));
    else ordered.push(...group(g));
  }
  ordered.forEach((r, i) => { r.rank = i + 1; });
  return ordered;
}

// 把已完賽的對戰轉成 standings 需要的格式
export const resultsFrom = (resolved) =>
  [...resolved.values()].filter((r) => r.state === 'done').map((r) => ({ a: r.p1, b: r.p2, games: r.match.games, winner: r.winner }));

// ---------------------------------------------------------------- 輪次名稱與最終名次

export function roundLabel(code, size) {
  if (code === 'T') return '季軍賽';
  if (code === 'GF') return '冠軍戰';
  const m = code.match(/^([WL])(\d+)-/);
  if (!m) return '';
  const r = Number(m[2]);
  const R = Math.log2(size);
  if (m[1] === 'L') return r === 2 * R - 2 ? '敗部決賽' : `敗部第 ${r} 輪`;
  const n = size / 2 ** (r - 1);
  return n === 2 ? '決賽' : n === 4 ? '準決賽' : `${n} 強`;
}

// 淘汰賽最終名次：[{ place, id }]，名次未定的不列出
export function knockoutPlacings(resolved, format) {
  const get = (code) => resolved.get(code);
  const out = [];
  const add = (place, id) => { if (id) out.push({ place, id }); };
  const finalOf = (r) => (r && (r.state === 'done' || r.state === 'bye') ? r : null);
  if (format === 'double') {
    const gf = finalOf(get('GF'));
    if (gf) { add(1, gf.winner); add(2, gf.loser); }
    const lbCodes = [...resolved.keys()].filter((c) => c.startsWith('L')).map((c) => Number(c.slice(1).split('-')[0]));
    const last = Math.max(0, ...lbCodes);
    const lf = finalOf(get(`L${last}-0`));
    if (lf) add(3, lf.loser);
    const prev = finalOf(get(`L${last - 1}-0`));
    if (prev && last - 1 >= 1 && [...resolved.keys()].filter((c) => c.startsWith(`L${last - 1}-`)).length === 1) add(4, prev.loser);
  } else {
    const rounds = Math.max(...[...resolved.keys()].filter((c) => c.startsWith('W')).map((c) => Number(c.slice(1).split('-')[0])));
    const f = finalOf(get(`W${rounds}-0`));
    if (f) { add(1, f.winner); add(2, f.loser); }
    const t = finalOf(get('T'));
    if (t) { add(3, t.winner); add(4, t.loser); }
  }
  return out;
}

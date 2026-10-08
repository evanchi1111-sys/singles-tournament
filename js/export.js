// 匯出 Excel 與 LINE 文字成績。ctx 由 app.js 提供：
// { title, divisions: [{ label, formatLabel, placings: [{place, name}], tables: [{ title, rows }], matches: [{ stage, round, p1, p2, score, games, winner }] }] }

const fileStamp = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export function exportExcel(ctx) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('匯出模組還在載入，請稍候幾秒再試');
  const wb = XLSX.utils.book_new();
  for (const d of ctx.divisions) {
    const summary = [
      [`${d.label}（${d.formatLabel}）`],
      [],
      ['名次', '選手'],
      ...d.placings.map((p) => [p.place, p.name]),
    ];
    for (const t of d.tables) {
      summary.push([], [t.title], ['名次', '選手', '勝', '敗', '局數', '得失分', '判定依據'], ...t.rows);
    }
    const ws1 = XLSX.utils.aoa_to_sheet(summary);
    ws1['!cols'] = [{ wch: 8 }, { wch: 14 }, { wch: 5 }, { wch: 5 }, { wch: 8 }, { wch: 10 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, ws1, `${d.label}名次`);
    const ws2 = XLSX.utils.json_to_sheet(d.matches.length ? d.matches.map((m) => ({
      階段: m.stage, 輪次: m.round, 選手一: m.p1, 選手二: m.p2, 局數比分: m.score, 各局比分: m.games, 勝方: m.winner,
    })) : [{ 說明: '（尚無比賽）' }]);
    ws2['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 34 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws2, `${d.label}對戰`);
  }
  XLSX.writeFile(wb, `${ctx.title}_${fileStamp(new Date())}.xlsx`);
}

export function lineReport(ctx) {
  const medal = ['', '🥇', '🥈', '🥉', '4️⃣'];
  const lines = [`🏓 ${ctx.title} 成績`];
  for (const d of ctx.divisions) {
    lines.push('', `【${d.label}】${d.formatLabel}`);
    if (d.placings.length) d.placings.forEach((p) => lines.push(`${medal[p.place] || `第 ${p.place} 名`} ${p.name}`));
    else lines.push('（名次尚未產生）');
  }
  return lines.join('\n');
}

// 共用導覽列：只有主辦登入後才會顯示（選手看不到其他比賽的入口）。
// 用法：<script type="module" src="js/nav.js" data-current="singles"></script>
// 各系統在每次畫面更新時會送出 'site-organizer' 事件（detail 為是否為主辦），導覽列就跟著顯示或隱藏。

const SITES = [
  { key: 'singles', label: '單打賽', path: '/singles-tournament/', dev: 8766 },
  { key: 'doubles', label: '雙打賽', path: '/DSC-table-tennis/', dev: 8767 },
  { key: 'team', label: '團體賽', path: '/team-lineup/', dev: 8768 },
  { key: 'players', label: '選手資料庫', path: '/players/', dev: 8769 },
];

if (!document.querySelector('.sitenav')) {
  const current = document.querySelector('script[data-current]')?.dataset.current || '';
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const demo = new URLSearchParams(location.search).has('demo');

  const nav = document.createElement('nav');
  nav.className = 'sitenav';
  nav.hidden = true; // 預設隱藏，確認是主辦才顯示
  nav.setAttribute('aria-label', '主辦：切換系統');
  nav.innerHTML = `<div class="sitenav-inner">${SITES.map((s) => {
    const href = (local ? `http://localhost:${s.dev}/` : s.path) + (demo ? '?demo' : '');
    return `<a href="${href}" class="${s.key === current ? 'on' : ''}" ${s.key === current ? 'aria-current="page"' : ''}>${s.label}</a>`;
  }).join('')}</div>`;
  document.body.prepend(nav);

  document.addEventListener('site-organizer', (e) => { nav.hidden = !e.detail; });
}

// Family Pick Pool: read-only dashboard (standings, weekly recap, player stats).
(function () {
  const cfg = window.POOL_CONFIG;
  const db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const S = window.Scoring;
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

  const state = {season: null, rows: [], players: cfg.players.slice(), wk: [], recaps: {}, week: null, tab: 'standings', seasons: []};

  // ---------- data ----------
  async function fetchAll(table, filter) {
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      let q = db.from(table).select('*').range(from, from + size - 1);
      q = filter(q);
      const {data, error} = await q;
      if (error) throw error;
      out.push(...data);
      if (data.length < size) break;
    }
    return out;
  }

  async function loadSeasons() {
    const {data, error} = await db.from('seasons').select('season, sweep_bonus_points').order('season', {ascending: false});
    if (error) throw error;
    state.seasons = data;
    const sel = $('season');
    sel.replaceChildren(...data.map((s) => new Option(s.season + ' season', String(s.season))));
    const fromHash = Number((location.hash.match(/season=(\d{4})/) || [])[1]);
    state.season = data.some((s) => s.season === fromHash) ? fromHash : (data.some((s) => s.season === cfg.defaultSeason) ? cfg.defaultSeason : data[0].season);
    sel.value = String(state.season);
    sel.addEventListener('change', () => { state.season = Number(sel.value); state.week = null; loadSeason(); });
  }

  async function loadPlayers() {
    const {data, error} = await db.from('players_public').select('code, active');
    if (error) throw error;
    const known = new Set(data.filter((p) => p.active).map((p) => p.code));
    const order = cfg.players.filter((p) => known.has(p));
    data.forEach((p) => { if (p.active && !order.includes(p.code)) order.push(p.code); });
    state.players = order;
  }

  async function loadSeason() {
    $('takeaway').textContent = 'Loading ' + state.season + '…';
    const rows = await fetchAll('pick_scores', (q) => q.eq('season', state.season).order('week').order('game_no'));
    rows.forEach((r) => { r.week = Number(r.week); r.game_no = Number(r.game_no); });
    const {data: recaps} = await db.from('recaps').select('*').eq('season', state.season);
    state.rows = rows;
    state.recaps = Object.fromEntries((recaps || []).map((r) => [r.week, r]));
    const players = state.players.filter((p) => rows.some((r) => r.player_code === p));
    state.seasonPlayers = players.length ? players : state.players;
    state.wk = S.weekly(rows, state.seasonPlayers);
    render();
  }

  // ---------- rendering ----------
  function render() {
    renderHeader();
    renderStandings();
    renderRecap();
    renderStats();
  }

  function latestWeek() {
    const done = S.weeksOf(state.rows).filter(({week}) => state.wk.some((r) => r.week === week && r.games > 0));
    return done.length ? done[done.length - 1] : null;
  }

  function renderHeader() {
    const st = S.standings(state.wk, state.seasonPlayers);
    state.st = st;
    const lw = latestWeek();
    const t = $('takeaway');
    if (!st.length || !lw) { t.textContent = 'No results yet for ' + state.season + '.'; return; }
    const lead = st.filter((r) => r.points === st[0].points).map((r) => r.player);
    const next = st.find((r) => r.points < st[0].points);
    t.replaceChildren(
      el('b', lead.join(' & ')), document.createTextNode(lead.length > 1 ? ' are tied for the lead with ' : ' leads with '),
      el('b', String(st[0].points)), document.createTextNode(' points'),
      ...(next ? [document.createTextNode(', '), el('b', String(st[0].points - next.points)), document.createTextNode(' ahead of ' + st.filter((r) => r.points === next.points).map((r) => r.player).join(' & '))] : []),
      document.createTextNode(', through ' + lw.label + '.'),
    );
  }

  function renderStandings() {
    const st = state.st;
    const lw = latestWeek();
    const bonus = (state.seasons.find((s) => s.season === state.season) || {}).sweep_bonus_points;
    $('scoring-note').textContent = 'One point each for the winner, the spread and the over/under' + (bonus ? ', plus a bonus point for getting all three right in a game' : '') + '. Pushes and ties score nothing.';
    if (!st.length) return;
    $('t-leader').textContent = st.filter((r) => r.points === st[0].points).map((r) => r.player).join(' & ');
    $('t-leader-sub').textContent = st[0].points + ' points';
    if (lw) {
      const ww = state.wk.filter((r) => r.week === lw.week);
      const top = Math.max(...ww.map((r) => r.points));
      $('t-week').textContent = ww.filter((r) => r.points === top).map((r) => r.player).join(' & ');
      $('t-week-sub').textContent = top + ' points in ' + lw.label;
    }
    const ms = Math.max(...st.map((r) => r.sweeps));
    $('t-sweeps').textContent = st.filter((r) => r.sweeps === ms).map((r) => r.player).join(' & ');
    $('t-sweeps-sub').textContent = ms + ' sweeps';
    $('standings-table').tBodies[0].replaceChildren(...st.map((r) => {
      const tr = el('tr');
      [r.player, r.points, r.behind || '–', r.winner, r.spread, r.ou, r.sweeps, r.weeksWon].forEach((v, i) => tr.append(el('td', String(v), i < 2 ? 'strong' : '')));
      return tr;
    }));
    drawRace();
  }

  function weekOptions() {
    return S.weeksOf(state.rows);
  }

  function renderRecap() {
    const weeks = weekOptions();
    const sel = $('week');
    sel.replaceChildren(...weeks.map((w) => new Option(w.label, String(w.week))));
    if (state.week == null || !weeks.some((w) => w.week === state.week)) state.week = (latestWeek() || weeks[weeks.length - 1] || {}).week;
    if (state.week != null) sel.value = String(state.week);
    sel.onchange = () => { state.week = Number(sel.value); renderRecap(); };
    if (state.week == null) return;
    const rc = S.recap(state.rows, state.wk, state.week);
    $('week-status').textContent = rc.status;
    // written recap, if one exists
    const w = state.recaps[state.week];
    $('writeup').hidden = !w;
    if (w) {
      $('writeup-title').textContent = w.title || 'This week';
      $('writeup-body').replaceChildren(...String(w.body_md).split(/\n\s*\n/).map((para) => el('p', para.replace(/[*_#>`]/g, '').trim())));
    }
    const facts = [['Top score', rc.top], ['Runner-up', rc.second], ['Low score', rc.low], ['Sweeps', rc.sweeps], ['Biggest upset', rc.upset], ['Lone correct calls', rc.lone], ['Everyone missed', rc.missed], ['Leader after the week', rc.leader]];
    $('facts').replaceChildren(...(rc.empty ? [el('dd', 'Waiting on results.')] : facts.flatMap(([k, v]) => {
      const dd = el('dd');
      (Array.isArray(v) ? v : [v]).forEach((line) => dd.append(el('div', line)));
      return [el('dt', k), dd];
    })));
    const ww = state.wk.filter((r) => r.week === state.week).sort((a, b) => b.points - a.points || b.cum - a.cum);
    $('week-table').tBodies[0].replaceChildren(...ww.map((r) => {
      const tr = el('tr');
      [r.player, r.winner, r.spread, r.ou, r.sweeps, r.points, r.cum].forEach((v, i) => tr.append(el('td', String(v), i === 0 || i === 5 ? 'strong' : '')));
      return tr;
    }));
    const players = state.seasonPlayers;
    const g = S.grid(state.rows, state.week, players);
    const head = el('tr');
    ['Game', 'Line', 'Result', ...players].forEach((h) => head.append(el('th', h)));
    $('picks-table').tHead.replaceChildren(head);
    $('picks-table').tBodies[0].replaceChildren(...g.map((r) => {
      const tr = el('tr');
      tr.append(el('td', r.game, 'strong'), el('td', r.line), el('td', r.result));
      players.forEach((p) => {
        const td = el('td');
        const pk = r.picks[p];
        if (!pk) td.append(el('span', 'hidden', 'pend'));
        else pk.forEach(([team, m], i) => {
          if (i) td.append(document.createTextNode(' / '));
          td.append(el('span', team + ' ' + m, m === '✓' ? 'ok' : m === '✗' ? 'no' : 'pend'));
        });
        tr.append(td);
      });
      return tr;
    }));
  }

  function renderStats() {
    const h = S.habits(state.rows, state.wk, state.seasonPlayers);
    $('habits-table').tBodies[0].replaceChildren(...h.map((r) => {
      const tr = el('tr');
      [r.player, r.winner, r.spread, r.ou, r.upsets, r.lay7, r.over, r.solo, r.best].forEach((v, i) => tr.append(el('td', String(v), i === 0 ? 'strong' : '')));
      return tr;
    }));
  }

  // ---------- points race chart ----------
  const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#e34948', '#008300'];
  function drawRace() {
    const box = $('race');
    box.replaceChildren();
    const players = state.seasonPlayers;
    const weeks = S.weeksOf(state.rows).filter(({week}) => state.wk.some((r) => r.week === week && r.games > 0));
    if (!weeks.length) return;
    const W = Math.max(300, box.clientWidth), H = 300;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Running points total by week');
    box.append(svg);
    const mk = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; svg.append(n); return n; };
    const maxY = Math.max(1, ...state.wk.map((r) => r.cum));
    const step = maxY > 400 ? 100 : maxY > 150 ? 50 : 25;
    const top = Math.ceil(maxY / step) * step;
    const last = weeks[weeks.length - 1].week;
    const ends = players.map((p, i) => ({p, i, v: (state.wk.find((r) => r.player === p && r.week === last) || {}).cum || 0}));
    const probe = mk('text', {class: 'axis'}, '');
    const textW = (s) => { probe.textContent = s; return probe.getComputedTextLength(); };
    const mL = textW(String(top)) + 10, mR = Math.max(...ends.map((e) => textW(e.p + ' ' + e.v))) + 16, mT = 10, mB = 26;
    probe.remove();
    const x = (k) => mL + (weeks.length === 1 ? 0 : (k / (weeks.length - 1)) * (W - mL - mR));
    const y = (v) => mT + (1 - v / top) * (H - mT - mB);
    for (let v = 0; v <= top; v += step) {
      mk('line', {x1: mL, x2: W - mR, y1: y(v), y2: y(v), class: 'grid'});
      mk('text', {x: mL - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis'}, String(v));
    }
    const every = Math.ceil(weeks.length / Math.max(2, Math.floor((W - mL - mR) / 48)));
    weeks.forEach((w, k) => { if (k % every === 0 || k === weeks.length - 1) mk('text', {x: x(k), y: H - 6, 'text-anchor': 'middle', class: 'axis'}, w.week > 18 ? w.label.split(' ')[0] : 'Wk ' + w.week); });
    players.forEach((p, i) => {
      const pts = weeks.map((w, k) => { const r = state.wk.find((q) => q.player === p && q.week === w.week); return [x(k), y(r ? r.cum : 0)]; });
      mk('path', {d: 'M' + pts.map((q) => q.join(',')).join('L'), fill: 'none', stroke: COLORS[i % COLORS.length], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'});
    });
    const placed = ends.map((e) => ({...e, y: y(e.v)})).sort((a, b) => a.y - b.y);
    for (let k = 1; k < placed.length; k++) if (placed[k].y - placed[k - 1].y < 14) placed[k].y = placed[k - 1].y + 14;
    placed.forEach((e) => {
      mk('circle', {cx: x(weeks.length - 1), cy: y(e.v), r: 3.5, fill: COLORS[e.i % COLORS.length]});
      mk('text', {x: x(weeks.length - 1) + 8, y: e.y + 4, class: 'endlab'}, e.p + ' ' + e.v);
    });
    const rule = mk('line', {y1: mT, y2: H - mB, class: 'rule', opacity: 0});
    const hit = mk('rect', {x: mL - 10, y: 0, width: W - mL - mR + 20, height: H, fill: 'transparent'});
    const tip = $('tip');
    const show = (ev) => {
      const r = svg.getBoundingClientRect();
      const mx = ((ev.clientX - r.left) / r.width) * W;
      let k = 0; weeks.forEach((_, j) => { if (Math.abs(x(j) - mx) < Math.abs(x(k) - mx)) k = j; });
      rule.setAttribute('x1', x(k)); rule.setAttribute('x2', x(k)); rule.setAttribute('opacity', 1);
      const wr = state.wk.filter((q) => q.week === weeks[k].week).sort((a, b) => b.cum - a.cum);
      tip.replaceChildren(el('div', 'After ' + weeks[k].label, 'tip-h'), ...wr.map((q) => {
        const d = el('div'); const sw = el('span', null, 'sw'); sw.style.background = COLORS[players.indexOf(q.player) % COLORS.length];
        d.append(sw, document.createTextNode(q.player + '  ' + q.cum + ' (+' + q.points + ')')); return d;
      }));
      tip.hidden = false;
      const left = Math.min(window.innerWidth - tip.offsetWidth - 8, ev.clientX + 14);
      tip.style.left = Math.max(8, left) + 'px';
      tip.style.top = (ev.clientY + 14) + 'px';
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; rule.setAttribute('opacity', 0); });
  }

  // ---------- tabs ----------
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('[data-page]').forEach((s) => { s.hidden = s.dataset.page !== name; });
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    if (name === 'standings' && state.rows.length) drawRace();
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); history.replaceState(null, '', '#' + b.dataset.tab); }));
  const h = location.hash.slice(1).split('&')[0];
  if (['standings', 'recap', 'stats'].includes(h)) showTab(h);
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.tab === 'standings' && state.rows.length) drawRace(); }, 150); });

  // ---------- start ----------
  (async () => {
    try {
      await Promise.all([loadSeasons(), loadPlayers()]);
      await loadSeason();
    } catch (e) {
      console.error(e);
      $('takeaway').textContent = '';
      const err = $('error');
      err.hidden = false;
      err.textContent = 'Couldn’t load the pool data. Check that config.js has your Supabase URL and public key, and that the setup SQL has been run. (' + (e.message || e) + ')';
    }
  })();
})();

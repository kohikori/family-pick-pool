// Family Pick Pool: read-only dashboard (standings, weekly recap, player stats).
(function () {
  const cfg = window.POOL_CONFIG;
  const db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const S = window.Scoring;
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

  const state = {season: null, rows: [], players: cfg.players.slice(), wk: [], recaps: {}, week: null, tab: 'dashboard', seasons: []};

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
  const MEDAL = ['🥇', '🥈', '🥉'];
  const pct = (v) => (v == null ? '–' : (v * 100).toFixed(1) + '%');
  const names = (list) => list.join(' & ');
  const set = (id, text) => { const e = $(id); if (e) e.textContent = text; };
  const rankCell = (r) => el('td', r <= 3 ? MEDAL[r - 1] + ' ' + r : String(r), 'rank');

  function render() {
    state.st = S.standings(state.wk, state.seasonPlayers);
    renderHeader();
    renderDashboard();
    renderWeek();
    renderStats();
  }

  function completedWeeks() {
    return S.weeksOf(state.rows).filter(({week}) => state.wk.some((r) => r.week === week && r.games > 0));
  }
  function latestWeek() { const d = completedWeeks(); return d.length ? d[d.length - 1] : null; }
  // A week is final when every game in it has a result.
  function weekIsFinal(week) {
    const g = S.gameResults(state.rows, week);
    return g.length > 0 && g.every((x) => x.final);
  }
  function lastFinalWeek() { const d = completedWeeks().filter((w) => weekIsFinal(w.week)); return d.length ? d[d.length - 1] : null; }

  function renderHeader() {
    const st = state.st, lw = latestWeek(), t = $('takeaway');
    if (!st.length || !lw) { t.textContent = 'No results yet for ' + state.season + '.'; return; }
    const lead = st.filter((r) => r.points === st[0].points).map((r) => r.player);
    const next = st.find((r) => r.points < st[0].points);
    t.replaceChildren(
      el('b', names(lead)), document.createTextNode(lead.length > 1 ? ' are tied for the lead with ' : ' leads with '),
      el('b', String(st[0].points)), document.createTextNode(' points'),
      ...(next ? [document.createTextNode(', '), el('b', String(st[0].points - next.points)), document.createTextNode(' ahead of ' + names(st.filter((r) => r.points === next.points).map((r) => r.player)))] : []),
      document.createTextNode(', through ' + lw.label + '.'),
    );
  }

  function leaderTile(prefix, key, accKey, unit) {
    const st = state.st;
    const best = Math.max(...st.map((r) => r[key]));
    const who = st.filter((r) => r[key] === best);
    set(prefix, names(who.map((r) => r.player)));
    set(prefix + '-val', best + ' ' + unit);
    if (accKey) set(prefix + '-sub', pct(who[0][accKey]) + ' accuracy (' + best + '/' + who[0].games + ')');
  }

  function renderDashboard() {
    const st = state.st;
    const bonus = (state.seasons.find((s) => s.season === state.season) || {}).sweep_bonus_points;
    set('scoring-note', 'GB: points behind the leader. Accuracy: share of all picks correct. Form: points in each week this season. One point per correct pick' + (bonus ? ', plus a bonus point for each game where all three picks were right' : '; this season had no sweep bonus') + '. Pushes and ties score nothing.');
    if (!st.length) return;
    // tiles
    const lead = st.filter((r) => r.points === st[0].points);
    const next = st.find((r) => r.points < st[0].points);
    set('k-leader', names(lead.map((r) => r.player)));
    set('k-leader-val', st[0].points + ' points');
    set('k-leader-sub', (next ? 'Lead: +' + (st[0].points - next.points) + ' over ' + next.player + ' (' + next.points + ')' : 'Tied at the top') + ' • ' + lead[0].sweeps + ' sweeps');
    const fw = lastFinalWeek() || latestWeek();
    if (fw) {
      const ww = state.wk.filter((r) => r.week === fw.week).sort((a, b) => b.points - a.points);
      const top = ww[0].points, win = ww.filter((r) => r.points === top), ru = ww.find((r) => r.points < top);
      set('k-week-label', '🏆 ' + fw.label + ' winner');
      set('k-week', names(win.map((r) => r.player)));
      set('k-week-val', top + ' points');
      set('k-week-sub', (ru ? 'Runner-up: ' + names(ww.filter((r) => r.points === ru.points).map((r) => r.player)) + ' (' + ru.points + ')' : '') + ' • ' + win[0].sweeps + ' sweeps');
    }
    leaderTile('k-su', 'winner', 'winnerAcc', 'wins');
    leaderTile('k-ats', 'spread', 'spreadAcc', 'wins');
    leaderTile('k-ou', 'ou', 'ouAcc', 'wins');
    const ms = Math.max(...st.map((r) => r.sweeps));
    set('k-sw', names(st.filter((r) => r.sweeps === ms).map((r) => r.player)));
    set('k-sw-val', ms + ' sweeps');
    set('k-sw-sub', 'Perfect 3-for-3 in ' + ms + ' games');

    // power rankings
    const rk = S.ranks(st, 'points');
    const maxForm = Math.max(1, ...st.flatMap((r) => r.form));
    const rows = st.map((r, i) => {
      const tr = el('tr');
      tr.append(rankCell(rk[i]), el('td', r.player, 'strong'), el('td', String(r.points), 'strong'), el('td', r.behind ? String(r.behind) : '–'),
        el('td', String(r.winner)), el('td', String(r.spread)), el('td', String(r.ou)), el('td', String(r.sweeps)), el('td', pct(r.accuracy)));
      const f = el('td', null, 'form'); f.append(spark(r.form, maxForm)); tr.append(f);
      return tr;
    });
    const avg = (k) => st.reduce((t, r) => t + (r[k] || 0), 0) / st.length;
    const ar = el('tr', null, 'avg');
    ar.append(el('td', ''), el('td', 'Pool avg'), el('td', avg('points').toFixed(1)), el('td', '–'), el('td', avg('winner').toFixed(1)), el('td', avg('spread').toFixed(1)), el('td', avg('ou').toFixed(1)), el('td', avg('sweeps').toFixed(1)), el('td', pct(avg('accuracy'))), el('td', completedWeeks().length + ' wks'));
    $('rank-table').tBodies[0].replaceChildren(...rows, ar);

    // single-week records
    const rec = S.records(state.wk);
    if (rec.length) {
      const r1 = rec[0], r2 = rec.find((r) => !(r.player === r1.player && r.week === r1.week));
      set('r1', r1.points + ' points • ' + r1.player);
      set('r1-sub', r1.label + ' • highest single-week score of the ' + state.season + ' season');
      set('r1-break', r1.winner + ' winners • ' + r1.spread + ' spreads • ' + r1.ou + ' O/U • ' + r1.sweeps + ' sweeps');
      if (r2) { set('r2', r2.points + ' points • ' + r2.player + ' (' + r2.label + ')'); set('r2-sub', (r1.points - r2.points ? (r1.points - r2.points) + ' behind the record' : 'Tied with the record')); }
      $('record-table').tBodies[0].replaceChildren(...rec.slice(0, 5).map((r) => {
        const tr = el('tr'); tr.append(el('td', r.player, 'strong'), el('td', r.label), el('td', String(r.points), 'strong'), el('td', String(r.sweeps))); return tr;
      }));
    }
    drawRace();
  }

  function spark(vals, max) {
    const NS = 'http://www.w3.org/2000/svg', W = 84, H = 22;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('aria-hidden', 'true');
    if (!vals.length) return svg;
    const x = (i) => (vals.length === 1 ? W / 2 : 3 + (i / (vals.length - 1)) * (W - 6));
    const y = (v) => H - 3 - (v / max) * (H - 6);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M' + vals.map((v, i) => x(i) + ',' + y(v)).join('L')); p.setAttribute('class', 'spark');
    svg.append(p);
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x(vals.length - 1)); c.setAttribute('cy', y(vals[vals.length - 1])); c.setAttribute('r', 2.5); c.setAttribute('class', 'spark-end');
    svg.append(c);
    const t = document.createElementNS(NS, 'title'); t.textContent = 'Weekly points: ' + vals.join(', '); svg.append(t);
    return svg;
  }

  function renderWeek() {
    const weeks = S.weeksOf(state.rows);
    const sel = $('week-sel');
    sel.replaceChildren(...weeks.map((w) => new Option(w.label, String(w.week))));
    if (state.week == null || !weeks.some((w) => w.week === state.week)) state.week = (latestWeek() || weeks[weeks.length - 1] || {}).week;
    if (state.week == null) return;
    sel.value = String(state.week);
    sel.onchange = () => { state.week = Number(sel.value); renderWeek(); };
    const label = (weeks.find((w) => w.week === state.week) || {}).label || '';
    const games = S.gameResults(state.rows, state.week);
    const nFinal = games.filter((g) => g.final).length;
    const status = nFinal === games.length ? 'Final' : nFinal ? 'In progress' : 'Upcoming';
    const pill = $('week-status'); pill.textContent = status; pill.className = 'pill ' + status.toLowerCase().replace(' ', '-');
    set('week-count', nFinal + ' of ' + games.length + ' games final');

    // tiles
    const ww = state.wk.filter((r) => r.week === state.week).sort((a, b) => b.points - a.points || b.sweeps - a.sweeps);
    const has = nFinal > 0 && ww.length;
    set('w-lead-label', '🏆 ' + label + (status === 'Final' ? ' winner' : ' leader'));
    if (has) {
      const top = ww[0].points, lead = ww.filter((r) => r.points === top), ru = ww.find((r) => r.points < top);
      set('w-lead', names(lead.map((r) => r.player)));
      set('w-lead-val', top + ' points');
      set('w-lead-sub', (ru ? 'Margin: +' + (top - ru.points) : 'Tied') + ' • ' + lead[0].sweeps + ' sweeps');
      set('w-second', ru ? names(ww.filter((r) => r.points === ru.points).map((r) => r.player)) : '–');
      set('w-second-val', ru ? ru.points + ' points' : '');
      const tot = ww.reduce((t, r) => t + r.points, 0);
      set('w-pool', tot + ' points');
      set('w-pool-val', (tot / ww.length).toFixed(1) + ' average per player');
    } else {
      ['w-lead', 'w-second', 'w-pool'].forEach((id) => set(id, '–'));
      ['w-lead-val', 'w-lead-sub', 'w-second-val', 'w-pool-val'].forEach((id) => set(id, 'Waiting on results'));
    }

    // written recap
    const w = state.recaps[state.week];
    $('writeup').hidden = !w;
    if (w) {
      set('writeup-title', w.title || 'This week');
      $('writeup-body').replaceChildren(...String(w.body_md).split(/\n\s*\n/).map((para) => el('p', para.replace(/[*_#>`]/g, '').trim())));
    }

    // leaderboard
    const rk = S.ranks(ww, 'points');
    const rows = ww.map((r, i) => {
      const tr = el('tr');
      tr.append(rankCell(rk[i]), el('td', r.player, 'strong'), el('td', String(r.points), 'strong'), el('td', String(r.winner)), el('td', String(r.spread)), el('td', String(r.ou)), el('td', String(r.sweeps)),
        el('td', r.games ? pct((r.winner + r.spread + r.ou) / (3 * r.games)) : '–'), el('td', String(r.cum)));
      return tr;
    });
    if (ww.length) {
      const a = (k) => (ww.reduce((t, r) => t + r[k], 0) / ww.length).toFixed(1);
      const g = ww.reduce((t, r) => t + r.games, 0);
      const ar = el('tr', null, 'avg');
      ar.append(el('td', ''), el('td', 'Week avg'), el('td', a('points')), el('td', a('winner')), el('td', a('spread')), el('td', a('ou')), el('td', a('sweeps')),
        el('td', g ? pct(ww.reduce((t, r) => t + r.winner + r.spread + r.ou, 0) / (3 * g)) : '–'), el('td', ''));
      rows.push(ar);
    }
    $('week-table').tBodies[0].replaceChildren(...rows);

    // week in review
    const rc = S.recap(state.rows, state.wk, state.week);
    const facts = [['Biggest upset', rc.upset], ['Lone correct calls', rc.lone], ['Everyone missed', rc.missed], ['Low score', rc.low], ['Leader after the week', rc.leader]];
    $('facts').replaceChildren(...(rc.empty ? [el('dd', 'Waiting on results.')] : facts.flatMap(([k, v]) => {
      const dd = el('dd'); (Array.isArray(v) ? v : [v]).forEach((line) => dd.append(el('div', line))); return [el('dt', k), dd];
    })));

    // game results
    $('games-table').tBodies[0].replaceChildren(...games.map((g) => {
      const tr = el('tr');
      tr.append(el('td', g.game, 'strong'), el('td', g.line), el('td', String(g.total)), el('td', g.final ? g.winner : 'Not final', g.final ? '' : 'pend'),
        el('td', g.covered), el('td', g.ou), el('td', g.pickedWinner));
      return tr;
    }));

    // every pick
    const players = state.seasonPlayers;
    const gr = S.grid(state.rows, state.week, players);
    const head = el('tr');
    ['Game', 'Line', 'Result', ...players].forEach((h) => head.append(el('th', h)));
    $('picks-table').tHead.replaceChildren(head);
    $('picks-table').tBodies[0].replaceChildren(...gr.map((r) => {
      const tr = el('tr');
      tr.append(el('td', r.game, 'strong'), el('td', r.line), el('td', r.result));
      players.forEach((p) => {
        const td = el('td'); const pk = r.picks[p];
        if (!pk) td.append(el('span', 'hidden', 'pend'));
        else pk.forEach(([team, m], i) => { if (i) td.append(document.createTextNode(' / ')); td.append(el('span', team + ' ' + m, m === '✓' ? 'ok' : m === '✗' ? 'no' : 'pend')); });
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
    if (name === 'dashboard' && state.rows.length) drawRace();
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); history.replaceState(null, '', '#' + b.dataset.tab); }));
  const h = location.hash.slice(1).split('&')[0];
  const legacy = {standings: 'dashboard', recap: 'week'};
  if (['dashboard', 'week', 'stats', 'standings', 'recap'].includes(h)) showTab(legacy[h] || h);
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.tab === 'dashboard' && state.rows.length) drawRace(); }, 150); });

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

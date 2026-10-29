// Family Pick Pool: read-only dashboard (standings, weekly recap, player stats).
(function () {
  const cfg = window.POOL_CONFIG;
  const db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const S = window.Scoring;
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

  const state = {season: null, rows: [], players: cfg.players.slice(), wk: [], recaps: {}, week: null, tab: 'dashboard', seasons: []};
  // Shared with picks.js (sign-in, My picks, Set lines).
  window.POOL = {db, cfg, $, el, state};

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
    renderDashRecap();
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
    const mw = Math.max(...st.map((r) => r.weeksWon));
    const ww = st.filter((r) => r.weeksWon === mw);
    set('k-ww', mw ? names(ww.map((r) => r.player)) : '–');
    set('k-ww-val', mw + (mw === 1 ? ' week' : ' weeks'));
    const wks = (r) => r.wonWeeks.map((l) => l.replace('Week ', 'Wk ')).join(', ');
    set('k-ww-sub', mw ? (ww.length === 1 ? wks(ww[0]) : ww.map((r) => r.player + ': ' + wks(r)).join(' • ')) : 'No finished weeks yet');

    // power rankings
    const rk = S.ranks(st, 'points');
    const maxForm = Math.max(1, ...st.flatMap((r) => r.form));
    const rows = st.map((r, i) => {
      const tr = el('tr');
      tr.append(rankCell(rk[i]), el('td', r.player, 'strong'), el('td', String(r.points), 'strong'), el('td', r.behind ? String(r.behind) : '–'),
        el('td', String(r.winner)), el('td', String(r.spread)), el('td', String(r.ou)), el('td', String(r.sweeps)), el('td', String(r.weeksWon)), el('td', pct(r.accuracy)));
      const f = el('td', null, 'form'); f.append(spark(r.form, maxForm)); tr.append(f);
      return tr;
    });
    const avg = (k) => st.reduce((t, r) => t + (r[k] || 0), 0) / st.length;
    const ar = el('tr', null, 'avg');
    ar.append(el('td', ''), el('td', 'Pool avg'), el('td', avg('points').toFixed(1)), el('td', '–'), el('td', avg('winner').toFixed(1)), el('td', avg('spread').toFixed(1)), el('td', avg('ou').toFixed(1)), el('td', avg('sweeps').toFixed(1)), el('td', avg('weeksWon').toFixed(1)), el('td', pct(avg('accuracy'))), el('td', completedWeeks().length + ' wks'));
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

  // Latest weekly recap, previewed on the Dashboard.
  function renderDashRecap() {
    const card = $('dash-recap');
    if (!card) return;
    const latest = Object.values(state.recaps).sort((a, b) => b.week - a.week)[0];
    card.hidden = !latest;
    if (!latest) return;
    const wl = (S.weeksOf(state.rows).find((w) => w.week === latest.week) || {}).label || 'Week ' + latest.week;
    set('dash-recap-week', '📰 ' + wl + ' recap');
    set('dash-recap-title', latest.title || wl);
    set('dash-recap-lede', String(latest.body_md || '').split(/\n\s*\n/)[0].replace(/[*_#>`]/g, '').trim());
    $('dash-recap-more').onclick = () => { state.week = latest.week; renderWeek(); window.POOL.showTab('week'); window.scrollTo(0, 0); };
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

  // ---------- leadership chart: standings rank after each week ----------
  const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#e34948', '#008300'];
  function drawRace() {
    const box = $('race');
    box.replaceChildren();
    const players = state.seasonPlayers;
    const hist = S.rankHistory(state.wk, players);
    if (!hist.length) return;
    const n = players.length;
    const W = Math.max(300, box.clientWidth), H = Math.max(240, 46 * n + 40);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Standings rank of each player after every week');
    box.append(svg);
    const mk = (tag, attrs, text, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; (parent || svg).append(e); return e; };
    const last = hist[hist.length - 1];
    const ordinal = (k) => k + (k % 10 === 1 && k !== 11 ? 'st' : k % 10 === 2 && k !== 12 ? 'nd' : k % 10 === 3 && k !== 13 ? 'rd' : 'th');
    const probe = mk('text', {class: 'endlab'}, '');
    const tw = (t) => { probe.textContent = t; return probe.getComputedTextLength(); };
    const endText = (p) => p + ' ' + last.ranks[p].cum;
    const mL = tw('6th') + 14, mR = Math.max(...players.map((p) => tw(endText(p)))) + 22, mT = 16, mB = 28;
    probe.remove();
    const x = (k) => mL + (hist.length === 1 ? (W - mL - mR) / 2 : (k / (hist.length - 1)) * (W - mL - mR));
    const y = (rank) => mT + ((rank - 1) / Math.max(1, n - 1)) * (H - mT - mB);
    for (let r = 1; r <= n; r++) {
      mk('line', {x1: mL, x2: W - mR, y1: y(r), y2: y(r), class: 'grid'});
      mk('text', {x: mL - 10, y: y(r) + 4, 'text-anchor': 'end', class: 'axis'}, ordinal(r));
    }
    const every = Math.ceil(hist.length / Math.max(2, Math.floor((W - mL - mR) / 46)));
    hist.forEach((h, k) => { if (k % every === 0 || k === hist.length - 1) mk('text', {x: x(k), y: H - 6, 'text-anchor': 'middle', class: 'axis'}, h.week > 18 ? h.label.split(' ')[0] : 'Wk ' + h.week); });
    // lines: leader drawn last so it sits on top
    const order = players.slice().sort((a, b) => last.ranks[b].rank - last.ranks[a].rank);
    const groups = {};
    order.forEach((p) => {
      const i = players.indexOf(p), col = COLORS[i % COLORS.length];
      const g = mk('g', {class: 'bump', 'data-p': p});
      groups[p] = g;
      const pts = hist.map((h, k) => [x(k), y(h.ranks[p].rank)]);
      mk('path', {d: 'M' + pts.map((q) => q.join(',')).join('L'), fill: 'none', stroke: col, 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'}, null, g);
      pts.forEach(([cx, cy]) => mk('circle', {cx, cy, r: 4.5, fill: col, class: 'bump-dot'}, null, g));
    });
    // end labels, nudged apart when players are tied on rank
    const ends = players.map((p) => ({p, i: players.indexOf(p), y: y(last.ranks[p].rank), rank: last.ranks[p].rank})).sort((a, b) => a.y - b.y || a.p.localeCompare(b.p));
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
    ends.forEach((e) => {
      const t = mk('text', {x: x(hist.length - 1) + 12, y: e.y + 4, class: 'endlab'}, endText(e.p));
      t.style.fill = COLORS[e.i % COLORS.length];
      t.style.fontWeight = '600';
    });
    // hover: highlight a player's line, show the week's order
    const tip = $('tip');
    const rule = mk('line', {y1: mT - 8, y2: H - mB + 4, class: 'rule', opacity: 0});
    const hit = mk('rect', {x: mL - 16, y: 0, width: W - mL - mR + 32, height: H, fill: 'transparent'});
    const show = (ev) => {
      const r = svg.getBoundingClientRect();
      const mx = ((ev.clientX - r.left) / r.width) * W, my = ((ev.clientY - r.top) / r.height) * H;
      let k = 0; hist.forEach((_, j) => { if (Math.abs(x(j) - mx) < Math.abs(x(k) - mx)) k = j; });
      const h = hist[k];
      const near = players.reduce((b, p) => (Math.abs(y(h.ranks[p].rank) - my) < Math.abs(y(h.ranks[b].rank) - my) ? p : b), players[0]);
      players.forEach((p) => groups[p].setAttribute('opacity', p === near ? 1 : 0.25));
      rule.setAttribute('x1', x(k)); rule.setAttribute('x2', x(k)); rule.setAttribute('opacity', 1);
      const sorted = players.slice().sort((a, b) => h.ranks[a].rank - h.ranks[b].rank || a.localeCompare(b));
      const top = h.ranks[sorted[0]].cum;
      tip.replaceChildren(el('div', 'After ' + h.label, 'tip-h'), ...sorted.map((p) => {
        const d = el('div'); const sw = el('span', null, 'sw'); sw.style.background = COLORS[players.indexOf(p) % COLORS.length];
        const q = h.ranks[p];
        d.append(sw, document.createTextNode(ordinal(q.rank) + '  ' + p + '  ' + q.cum + (q.cum < top ? ' (−' + (top - q.cum) + ')' : '') + '  +' + q.points + ' this wk'));
        if (p === near) d.style.fontWeight = '700';
        return d;
      }));
      tip.hidden = false;
      tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, ev.clientX + 14)) + 'px';
      tip.style.top = (ev.clientY + 14) + 'px';
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; rule.setAttribute('opacity', 0); players.forEach((p) => groups[p].setAttribute('opacity', 1)); });
  }

  // ---------- tabs ----------
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('[data-page]').forEach((s) => { s.hidden = s.dataset.page !== name; });
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    if (name === 'dashboard' && state.rows.length) drawRace();
    if (window.POOL.onTab) window.POOL.onTab(name);
  }
  window.POOL.showTab = (name) => { showTab(name); history.replaceState(null, '', '#' + name); };
  window.POOL.reload = () => loadSeason();
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); history.replaceState(null, '', '#' + b.dataset.tab); }));
  const h = location.hash.slice(1).split('&')[0];
  const legacy = {standings: 'dashboard', recap: 'week'};
  if (['dashboard', 'week', 'stats', 'picks', 'lines', 'standings', 'recap'].includes(h)) showTab(legacy[h] || h);
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.tab === 'dashboard' && state.rows.length) drawRace(); }, 150); });

  // ---------- start ----------
  (async () => {
    // index.html and app.js must come from the same update.
    if (!document.getElementById('rank-table')) {
      const err = $('error');
      err.hidden = false;
      err.textContent = 'This page is out of date compared with app.js. Re-upload index.html from the latest update, wait a minute, then refresh with Cmd+Shift+R (Ctrl+Shift+R on Windows).';
      $('takeaway').textContent = '';
      return;
    }
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

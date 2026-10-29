// Family Pick Pool: game-day extras on the My picks cards.
//   • Weather: only notable conditions at outdoor stadiums (Open-Meteo, free, no key).
//   • QB: who's actually starting when a team's QB is out, doubtful or on IR (ESPN depth charts).
//   • Injuries: starters (QB1, RB1, top 3 WR, TE1) listed Out, Doubtful or Questionable (ESPN game summaries).
// Everything here is best-effort: if a source is down or changes, cards simply show nothing extra.
(function () {
  // Outdoor stadiums only (domes, retractable roofs and SoFi are left out on purpose).
  const OUTDOOR = {
    BAL: [39.278, -76.623], BUF: [42.774, -78.787], CAR: [35.226, -80.853], CHI: [41.862, -87.617],
    CIN: [39.095, -84.516], CLE: [41.506, -81.700], DEN: [39.744, -105.020], GB: [44.501, -88.062],
    JAX: [30.324, -81.637], KC: [39.049, -94.484], MIA: [25.958, -80.239], NE: [42.091, -71.264],
    NYG: [40.814, -74.074], NYJ: [40.814, -74.074], PHI: [39.901, -75.168], PIT: [40.447, -80.016],
    SF: [37.403, -121.970], SEA: [47.595, -122.332], TB: [27.976, -82.503], TEN: [36.166, -86.771],
    WAS: [38.908, -76.864],
  };
  // When it counts as "notable".
  const T = {wind: 15, gust: 30, cold: 25, hot: 90, rainChance: 60, rainIn: 0.1, heavyRainIn: 0.4, snowIn: 0.2};
  const KEY_POS = ['QB', 'RB', 'WR', 'TE'];
  const ESPN_FIX = {WSH: 'WAS'};
  const TTL = 30 * 60 * 1000;           // refresh at most every 30 minutes
  const cache = {weather: {}, injuries: {}, events: {}, depth: {}, at: {}};
  const teamIds = {};
  const DEBUG = /[?&]debug/.test(location.search);   // add ?debug to the address to see what ESPN returned

  const fresh = (k) => cache.at[k] && Date.now() - cache.at[k] < TTL;
  const getJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.json(); };

  // ---------- weather ----------
  async function weatherFor(g) {
    const loc = !g.neutral_site && OUTDOOR[g.home];
    if (!loc || !g.kickoff) return null;
    const ko = new Date(g.kickoff);
    const days = (ko - Date.now()) / 864e5;
    if (days < 0 || days > 10) return null;              // forecasts beyond ~10 days aren't worth showing
    const day = ko.toISOString().slice(0, 10);
    const next = new Date(ko.getTime() + 864e5).toISOString().slice(0, 10);
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc[0] + '&longitude=' + loc[1] +
      '&hourly=temperature_2m,precipitation_probability,precipitation,snowfall,wind_speed_10m,wind_gusts_10m' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=GMT&start_date=' + day + '&end_date=' + next;
    const j = await getJSON(url);
    const h = j.hourly || {};
    const t0 = ko.getTime();
    // The three hours from kickoff.
    const idx = (h.time || []).map((t, i) => [new Date(t + 'Z').getTime(), i]).filter(([t]) => t >= t0 - 30 * 60e3 && t < t0 + 3 * 3600e3).map(([, i]) => i);
    if (!idx.length) return null;
    const col = (k) => idx.map((i) => (h[k] || [])[i]).filter((v) => v != null);
    const max = (k) => Math.max(...col(k), 0), sum = (k) => col(k).reduce((a, b) => a + b, 0);
    const temps = col('temperature_2m');
    const temp = temps.length ? Math.round(temps[0]) : null;
    const wind = Math.round(max('wind_speed_10m')), gust = Math.round(max('wind_gusts_10m'));
    const chance = Math.round(max('precipitation_probability')), rain = sum('precipitation'), snow = sum('snowfall');
    const bits = [];
    if (snow >= T.snowIn) bits.push('❄️ Snow (' + snow.toFixed(1) + '″)');
    else if (chance >= T.rainChance && rain >= T.rainIn) bits.push((rain >= T.heavyRainIn ? '🌧️ Heavy rain' : '🌧️ Rain') + ' (' + chance + '%)');
    if (wind >= T.wind || gust >= T.gust) bits.push('💨 Wind ' + wind + ' mph' + (gust >= wind + 8 ? ', gusts ' + gust : ''));
    if (temp != null && temp <= T.cold) bits.push('🥶 ' + temp + '°F');
    if (temp != null && temp >= T.hot) bits.push('🥵 ' + temp + '°F');
    if (!bits.length) return null;
    if (temp != null && !bits.some((b) => b.includes('°F'))) bits.push(temp + '°F');
    return bits.join(' · ');
  }

  // ---------- injuries (ESPN) ----------
  function espnWeekParams(week) {
    if (week <= 18) return 'seasontype=2&week=' + week;
    return 'seasontype=3&week=' + ({19: 1, 20: 2, 21: 3, 22: 5}[week] || week - 18);
  }
  const code = (abbr) => { const a = String(abbr || '').toUpperCase(); return ESPN_FIX[a] || a; };

  async function eventIds(season, week) {
    const k = season + '-' + week;
    if (cache.events[k] && fresh('ev' + k)) return cache.events[k];
    const j = await getJSON('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=' + season + '&' + espnWeekParams(week));
    const map = {};
    (j.events || []).forEach((ev) => {
      const c = (ev.competitions || [])[0] || {};
      const side = (h) => (c.competitors || []).find((x) => x.homeAway === h) || {};
      const a = code((side('away').team || {}).abbreviation), hm = code((side('home').team || {}).abbreviation);
      if (a && hm) map[a + '@' + hm] = ev.id;
      if (a) teamIds[a] = (side('away').team || {}).id;
      if (hm) teamIds[hm] = (side('home').team || {}).id;
    });
    cache.events[k] = map; cache.at['ev' + k] = Date.now();
    return map;
  }

  const statusOf = (x) => String((x.status && (x.status.name || x.status.type || x.status)) || (x.type && (x.type.description || x.type.name)) || '');
  const isIR = (s) => /injured reserve|^ir$/i.test(s);
  const label = (s) => (isIR(s) ? 'IR' : s.toLowerCase());
  const SEV = {out: 0, doubtful: 1, questionable: 2};
  const short = (a) => (a && (a.shortName || a.displayName || a.fullName)) || '';

  // ESPN summary.injuries -> {TEAM: [{id, name, pos, status}]}, tolerating small shape differences.
  function readInjuries(summary) {
    const out = {};
    (summary.injuries || []).forEach((t) => {
      const team = code((t.team || {}).abbreviation);
      if (!team) return;
      out[team] = (t.injuries || []).map((x) => {
        const ath = x.athlete || {};
        return {id: String(ath.id || ''), name: short(ath), pos: ((ath.position || {}).abbreviation || x.position || '').toUpperCase(), status: statusOf(x)};
      }).filter((x) => x.name);
    });
    return out;
  }

  // ESPN depth chart -> {QB: [...], RB: [...], WR: [...], TE: [...]} in depth order, offense only.
  // Accepts the current `depthchart` key and the older `depthCharts` / `items` forms.
  function readDepth(j) {
    const charts = j.depthchart || j.depthCharts || j.depthcharts || j.items || [];
    const out = {QB: [], RB: [], WR: [], TE: []};
    for (const ch of [].concat(charts)) {
      const groups = Object.values((ch && ch.positions) || {});
      if (!groups.some((g) => /^qb$/i.test(((g.position || {}).abbreviation) || ''))) continue;   // offense chart only
      groups.forEach((g) => {
        const pos = (((g.position || {}).abbreviation) || '').toUpperCase();
        if (!out[pos]) return;
        const aths = (g.athletes || []).slice().sort((x, y) => (x.rank || x.slot || 0) - (y.rank || y.slot || 0) || 0)
          .map((x) => x.athlete || x).map((x) => ({id: String(x.id || ''), name: short(x)})).filter((x) => x.name);
        if (pos === 'WR') { if (aths[0]) out.WR.push(aths[0]); } else if (!out[pos].length) out[pos] = aths;
      });
      if (out.QB.length) break;
    }
    return out.QB.length ? out : null;
  }

  async function depthFor(team) {
    const id = teamIds[team];
    if (!id) return null;
    if (cache.depth[team] !== undefined && fresh('d' + team)) return cache.depth[team];
    let d = null;
    try { d = readDepth(await getJSON('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/' + id + '/depthcharts')); } catch (e) { d = null; }
    cache.depth[team] = d; cache.at['d' + team] = Date.now();
    return d;
  }

  const same = (a, b) => (a.id && b.id ? a.id === b.id : a.name === b.name);

  // One team's notes: {qb: 'T. Pickett starting (J. Hurts, IR)' | null, hurt: ['A.J. Brown (WR, questionable)', ...]}
  function teamNotes(inj, depth) {
    inj = inj || [];
    const sev = (x) => SEV[x.status.toLowerCase()];
    let qb = null, hurt;
    if (depth) {
      const starters = [...depth.QB.slice(0, 1), ...depth.RB.slice(0, 1), ...depth.WR.slice(0, 3), ...depth.TE.slice(0, 1)];
      // Starting QB: first QB on the depth chart who isn't out or on IR.
      const unavailable = (a) => inj.some((x) => same(x, a) && (isIR(x.status) || /^out$/i.test(x.status)));
      const starter = depth.QB.find((a) => !unavailable(a));
      const missing = inj.filter((x) => x.pos === 'QB' && (isIR(x.status) || /^(out|doubtful)$/i.test(x.status)) && !(starter && same(x, starter)));
      if (starter && missing.length) qb = starter.name + ' starting (' + missing.slice(0, 2).map((x) => x.name + ', ' + label(x.status)).join('; ') + ')';
      hurt = inj.filter((x) => sev(x) != null && starters.some((a) => same(a, x)) && !(x.pos === 'QB' && qb && /out/i.test(x.status)));
    } else {
      // No depth chart: fall back to key positions only.
      hurt = inj.filter((x) => sev(x) != null && KEY_POS.includes(x.pos));
    }
    hurt.sort((a, b) => (b.pos === 'QB') - (a.pos === 'QB') || sev(a) - sev(b) || KEY_POS.indexOf(a.pos) - KEY_POS.indexOf(b.pos));
    return {qb, hurt: hurt.slice(0, 3).map((x) => x.name + ' (' + x.pos + ', ' + label(x.status) + ')')};
  }

  async function injuriesFor(g, ids) {
    const id = ids[g.away + '@' + g.home] || ids[g.home + '@' + g.away];
    if (!id) return DEBUG ? ['🔧 No ESPN game found for ' + g.away + ' @ ' + g.home + ' (ESPN has: ' + Object.keys(ids).join(', ') + ')'] : null;
    const [s, da, dh] = await Promise.all([
      getJSON('https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=' + id),
      depthFor(g.away), depthFor(g.home)]);
    const inj = readInjuries(s);
    const notes = {[g.away]: teamNotes(inj[g.away], da), [g.home]: teamNotes(inj[g.home], dh)};
    const out = [];
    if (DEBUG) {
      const d = (t, dep) => t + ': ' + (inj[t] || []).length + ' on injury list' +
        ((inj[t] || []).filter((x) => x.pos === 'QB').map((x) => ' [' + x.name + ' ' + x.status + ']').join('') || '') +
        ' · depth chart ' + (dep ? 'QBs ' + dep.QB.map((x) => x.name).join(' > ') : 'not read (team id ' + (teamIds[t] || 'missing') + ')');
      out.push('🔧 event ' + id + ' · ' + d(g.away, da) + ' | ' + d(g.home, dh));
    }
    const qbs = [g.away, g.home].filter((t) => notes[t].qb).map((t) => t + ' ' + notes[t].qb);
    if (qbs.length) out.push('🏈 QB: ' + qbs.join(' · '));
    const hurt = [g.away, g.home].filter((t) => notes[t].hurt.length).map((t) => t + ': ' + notes[t].hurt.join(', '));
    if (hurt.length) out.push('🩹 ' + hurt.join(' · '));
    return out.length ? out : null;
  }

  // ---------- public ----------
  // Loads extras for the open (not yet kicked off) games and calls onUpdate(game) as each arrives.
  async function load(games, season, onUpdate) {
    const open = games.filter((g) => g.kickoff && new Date(g.kickoff) > new Date());
    if (!open.length) return;
    open.forEach((g) => {
      if (fresh('w' + g.id)) return;
      cache.at['w' + g.id] = Date.now();
      weatherFor(g).then((v) => { cache.weather[g.id] = v; onUpdate(g); }).catch(() => {});
    });
    const week = open[0].week;
    let ids = {};
    try { ids = await eventIds(season, week); } catch (e) { if (DEBUG) open.forEach((g) => { cache.injuries[g.id] = ['🔧 ESPN schedule failed: ' + e.message]; onUpdate(g); }); return; }
    open.forEach((g) => {
      if (fresh('i' + g.id)) return;
      cache.at['i' + g.id] = Date.now();
      injuriesFor(g, ids).then((v) => { cache.injuries[g.id] = v; onUpdate(g); }).catch((e) => { if (DEBUG) { cache.injuries[g.id] = ['🔧 ESPN error: ' + e.message]; onUpdate(g); } });
    });
  }
  function lines(g) {
    if (!g.kickoff || new Date(g.kickoff) <= new Date()) return [];
    return [cache.weather[g.id], ...(cache.injuries[g.id] || [])].filter(Boolean);
  }
  window.PoolExtras = {load, lines, _test: {readInjuries, readDepth, teamNotes}};
})();

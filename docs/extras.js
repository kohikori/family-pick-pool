// Family Pick Pool: game-day notes on the My picks cards.
//   • Weather: only notable conditions at outdoor stadiums (Open-Meteo, free, no key).
//   • Backup QB: when a team's usual starter isn't starting (saved by the "QB watch" GitHub job).
// Everything here is best-effort: if a source is down, cards simply show nothing extra.
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
  const TTL = 30 * 60 * 1000;           // refresh at most every 30 minutes
  const cache = {weather: {}, qb: {}, at: {}};

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

  // ---------- backup QBs (qb_notes table) ----------
  async function loadQB(season, week) {
    const k = season + '-' + week;
    if (fresh('qb' + k)) return;
    cache.at['qb' + k] = Date.now();
    const db = window.POOL && window.POOL.db;
    if (!db) return;
    const {data, error} = await db.from('qb_notes').select('team, starter, usual').eq('season', season).eq('week', week);
    if (error) return;
    cache.qb[k] = data || [];
  }
  function qbLine(g) {
    const notes = (cache.qb[g.season + '-' + g.week] || []).filter((n) => n.team === g.away || n.team === g.home);
    return notes.length ? '🏈 ' + notes.map((n) => n.team + ': ' + n.starter + ' starting at QB (in for ' + n.usual + ')').join(' · ') : null;
  }

  // ---------- public ----------
  // Loads notes for the open (not yet kicked off) games and calls onUpdate(game) as each arrives.
  async function load(games, season, onUpdate) {
    const open = games.filter((g) => g.kickoff && new Date(g.kickoff) > new Date());
    if (!open.length) return;
    open.forEach((g) => {
      if (fresh('w' + g.id)) return;
      cache.at['w' + g.id] = Date.now();
      weatherFor(g).then((v) => { cache.weather[g.id] = v; onUpdate(g); }).catch(() => {});
    });
    try { await loadQB(open[0].season || season, open[0].week); } catch (e) { return; }
    open.forEach(onUpdate);
  }
  function lines(g) {
    if (!g.kickoff || new Date(g.kickoff) <= new Date()) return [];
    return [qbLine(g), cache.weather[g.id]].filter(Boolean);
  }
  window.PoolExtras = {load, lines};
})();

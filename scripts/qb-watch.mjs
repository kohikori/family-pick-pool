// Family Pick Pool: backup-QB watch.
// Runs from GitHub Actions (.github/workflows/qb-watch.yml) a few times a day, or by hand:
//   SUPABASE_SECRET_KEY=sb_secret_... node scripts/qb-watch.mjs
//
// For each team playing in the upcoming week:
//   • usual starter = the QB who led the team in passing in the most games this season (ESPN box scores)
//   • this week's starter = QB1 on ESPN's depth chart (or, if that can't be read, last game's starter)
// If this week's starter isn't the usual starter, and hasn't started as many games, the team gets a
// note in the qb_notes table. The My picks cards show it as:
//   🏈 PHI: T. Pickett starting at QB (in for J. Hurts)
//
// Settings: SUPABASE_SECRET_KEY (required), SEASON / WEEK (optional overrides),
//           ESPN_BASE (testing only), SUPABASE_URL / SUPABASE_REST (testing only).

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configText = readFileSync(join(root, 'docs', 'config.js'), 'utf8');
const fromConfig = (k) => (configText.match(new RegExp(k + "\\s*:\\s*'([^']+)'")) || [])[1];
const env = process.env;
const URL_BASE = (env.SUPABASE_URL || fromConfig('supabaseUrl') || '').replace(/\/+$/, '');
const REST = env.SUPABASE_REST || URL_BASE + '/rest/v1';
const KEY = env.SUPABASE_SECRET_KEY;
const ESPN = (env.ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl').replace(/\/+$/, '');
if (!KEY) { console.error('SUPABASE_SECRET_KEY is not set. Add it under Settings → Secrets and variables → Actions.'); process.exit(1); }

// ---------- helpers ----------
const headers = {apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json'};
async function api(path, opts = {}) {
  const r = await fetch(REST + path, {...opts, headers: {...headers, ...(opts.headers || {})}});
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 404) throw new Error('404');
    } catch (e) { if (String(e.message) === '404' || i === 2) throw new Error(url + ' → ' + e.message); }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  throw new Error(url + ' failed');
}
async function pool(items, n, fn) {           // run fn over items, n at a time
  const out = []; let i = 0;
  await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({error: e.message})); } }));
  return out;
}
const FIX = {WSH: 'WAS'};
const code = (a) => { const x = String(a || '').toUpperCase(); return FIX[x] || x; };
const weekParams = (w) => (w <= 18 ? 'seasontype=2&week=' + w : 'seasontype=3&week=' + ({19: 1, 20: 2, 21: 3, 22: 5}[w] || w - 18));
const short = (a) => (a && (a.shortName || a.displayName || a.fullName)) || '';
const lastName = (s) => String(s || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\.?$/,'').trim().split(/\s+/).pop();
const same = (a, b) => (a.id && b.id ? String(a.id) === String(b.id) : lastName(a.name) === lastName(b.name));
// Outline of a JSON value, for the log when ESPN's format surprises us.
function shape(j, d = 0) {
  if (j == null || typeof j !== 'object' || d > 4) return JSON.stringify(j === undefined ? null : j).slice(0, 40);
  if (Array.isArray(j)) return '[' + j.length + ']' + (j.length ? ' ' + shape(j[0], d + 1) : '');
  const ks = Object.keys(j);
  const big = ks.find((k) => j[k] && typeof j[k] === 'object' && Object.keys(j[k]).length);
  return '{' + ks.slice(0, 10).join(',') + (ks.length > 10 ? ',…' : '') + '}' + (big ? ' ' + big + '→' + shape(j[big], d + 1) : '');
}

// ---------- ESPN: schedule ----------
async function scoreboard(season, week) {
  const j = await getJSON(`${ESPN}/scoreboard?dates=${season}&${weekParams(week)}`);
  return (j.events || []).map((ev) => {
    const c = (ev.competitions || [])[0] || {};
    const teams = (c.competitors || []).map((x) => ({code: code((x.team || {}).abbreviation), id: String((x.team || {}).id || '')}));
    return {id: String(ev.id), week, done: !!(c.status && c.status.type && c.status.type.completed), teams};
  });
}

// ---------- ESPN: who started at QB in a finished game ----------
// The starter is the player with the most pass attempts in the box score.
function attemptsOf(a, keys) {
  const stats = a.stats || [];
  const i = (keys || []).findIndex((k) => /completions\/passingAttempts|passingAttempts/i.test(k));
  const raw = i >= 0 ? stats[i] : stats.find((s) => /^\d+\/\d+$/.test(String(s)));
  const m = String(raw || '').match(/(\d+)\s*\/\s*(\d+)/);
  return m ? Number(m[2]) : Number(raw) || 0;
}
async function gameStarters(eventId) {
  const s = await getJSON(`${ESPN}/summary?event=${eventId}`);
  const out = {};
  ((s.boxscore || {}).players || []).forEach((t) => {
    const team = code((t.team || {}).abbreviation);
    const passing = (t.statistics || []).find((x) => /passing/i.test(x.name || x.text || ''));
    if (!team || !passing) return;
    const best = (passing.athletes || []).map((a) => ({a: a.athlete || {}, att: attemptsOf(a, passing.keys || passing.labels)}))
      .sort((x, y) => y.att - x.att)[0];
    if (best && short(best.a)) out[team] = {id: String(best.a.id || ''), name: short(best.a)};
  });
  return out;
}

// ---------- ESPN: depth chart QB order ----------
async function resolve(x) {                    // athlete objects may be links ($ref) to fetch
  const a = (x && (x.athlete || x)) || {};
  if (short(a)) return {id: String(a.id || ''), name: short(a)};
  if (a.$ref) { try { const j = await getJSON(a.$ref.replace(/^http:\/\/([a-z.]*espn\.com)/, 'https://$1')); return {id: String(j.id || ''), name: short(j)}; } catch (e) { return null; } }
  return null;
}
async function depthQBs(teamId) {
  const j = await getJSON(`${ESPN}/teams/${teamId}/depthcharts`);
  const charts = [].concat(j.depthchart || j.depthCharts || j.depthcharts || j.items || []);
  for (const ch of charts) {
    const pos = (ch && ch.positions) || {};
    const key = Object.keys(pos).find((k) => /^qb$/i.test(k) || /^qb$/i.test(((pos[k] || {}).position || {}).abbreviation || ''));
    if (!key) continue;
    const aths = (pos[key].athletes || []).slice().sort((x, y) => (x.rank || x.slot || 0) - (y.rank || y.slot || 0));
    const list = (await Promise.all(aths.slice(0, 3).map(resolve))).filter(Boolean);
    if (list.length) return list;
  }
  throw new Error('no QBs found in depth chart: ' + shape(j));
}

// ---------- main ----------
(async () => {
  const season = Number(env.SEASON) || (await api('/seasons?select=season&order=season.desc&limit=1'))[0].season;
  let week = Number(env.WEEK) || null;
  if (!week) {
    const next = await api(`/games?select=week&season=eq.${season}&kickoff=gt.${new Date().toISOString()}&order=kickoff&limit=1`);
    week = next.length ? next[0].week : null;
  }
  if (!week) { console.log(`No upcoming ${season} games in the database. Nothing to do.`); return; }
  console.log(`Season ${season}, upcoming week ${week}.`);

  // 1. Everything played so far this season.
  const past = (await pool(Array.from({length: week - 1}, (_, i) => i + 1), 4, (w) => scoreboard(season, w))).flatMap((x) => (Array.isArray(x) ? x : []));
  const finished = past.filter((e) => e.done);
  console.log(`Reading ${finished.length} finished games…`);
  const starters = await pool(finished, 8, (e) => gameStarters(e.id).then((s) => ({week: e.week, s})));
  const tally = {};   // team -> {key -> {id, name, starts, last}}
  let readable = 0;
  starters.forEach((r) => {
    if (!r || r.error || !r.s) return;
    if (Object.keys(r.s).length) readable++;
    Object.entries(r.s).forEach(([team, p]) => {
      const t = (tally[team] = tally[team] || {});
      const k = Object.keys(t).find((x) => same(t[x], p)) || (p.id || p.name);
      t[k] = t[k] || {...p, starts: 0, last: 0};
      t[k].starts++; t[k].last = Math.max(t[k].last, r.week);
    });
  });
  const errors = starters.filter((r) => r && r.error);
  if (errors.length) console.log(`${errors.length} games couldn't be read, e.g. ${errors[0].error}`);
  if (finished.length && !readable) { console.log('Could not read any box scores; leaving notes unchanged. Sample summary shape: ' + shape(await getJSON(`${ESPN}/summary?event=${finished[0].id}`))); process.exit(1); }

  // 2. This week's games and each team's expected starter.
  const games = await scoreboard(season, week);
  const teams = games.flatMap((g) => g.teams).filter((t) => t.code);
  const notes = [];
  let depthOK = 0, depthErr = null;
  for (const t of teams) {
    const list = Object.values(tally[t.code] || {});
    if (!list.length) { console.log(`${t.code}: no games yet`); continue; }
    list.sort((a, b) => b.starts - a.starts || b.last - a.last);
    const usual = list[0];
    const lastStarter = list.slice().sort((a, b) => b.last - a.last || b.starts - a.starts)[0];
    let expected = null, source = 'depth chart';
    try { expected = (await depthQBs(t.id))[0]; depthOK++; } catch (e) { depthErr = depthErr || e.message; }
    if (!expected) { expected = lastStarter; source = 'last game'; }
    const known = list.find((p) => same(p, expected)) || {...expected, starts: 0};
    const flag = !same(known, usual) && known.starts < usual.starts;
    console.log(`${t.code.padEnd(4)} usual ${usual.name} (${usual.starts})  this week ${known.name} (${known.starts}, ${source})${flag ? '  ← BACKUP' : ''}`);
    if (flag) notes.push({season, week, team: t.code, starter: known.name, usual: usual.name, updated_at: new Date().toISOString()});
  }
  if (!depthOK && depthErr) console.log('Depth charts unreadable, used last game\'s starter instead. ' + depthErr);

  // 3. Save: replace this week's notes.
  await api(`/qb_notes?season=eq.${season}&week=eq.${week}`, {method: 'DELETE', headers: {Prefer: 'return=minimal'}});
  if (notes.length) await api('/qb_notes', {method: 'POST', headers: {Prefer: 'return=minimal'}, body: JSON.stringify(notes)});
  console.log(notes.length ? `Saved ${notes.length} backup-QB note(s): ` + notes.map((n) => `${n.team} ${n.starter} for ${n.usual}`).join('; ') : 'No backup QBs starting this week.');
})().catch((e) => { console.error(e.message || e); process.exit(1); });

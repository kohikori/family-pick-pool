// Family Pick Pool: weekly recap job.
// Runs from GitHub Actions (see .github/workflows/weekly-recap.yml), or by hand:
//   SUPABASE_SECRET_KEY=sb_secret_... node scripts/weekly-recap.mjs
//
// 1. Pulls final scores for the week from ESPN (skip with SKIP_SCORES=1).
// 2. If every game that week is final and no recap exists yet, works out the week's numbers
//    with the same scoring code the website uses (docs/scoring.js).
// 3. Writes the recap: with Claude if ANTHROPIC_API_KEY is set, otherwise from built-in templates.
// 4. Saves it to the recaps table, where the site shows it.
//
// Settings (environment variables):
//   SUPABASE_SECRET_KEY  required. The project's secret key (sb_secret_...). Keep it in GitHub Secrets only.
//   ANTHROPIC_API_KEY    optional. If set, Claude writes the recap.
//   WEEK                 optional. Week number to recap (default: the most recent week that has started).
//   SEASON               optional. Default: the latest season in the database.
//   FORCE=1              rewrite the recap even if one exists, or even if the week isn't final.
//   SKIP_SCORES=1        don't fetch scores from ESPN.
//   RECAP_MODEL          optional. Claude model to use (default claude-sonnet-5-5).
//   SUPABASE_URL         optional. Defaults to the URL in docs/config.js.
//   GMAIL_USER, GMAIL_APP_PASSWORD   the pool Gmail account; needed to email the recap.
//   EMAIL                who gets the email when a recap is written: all (default), me (commissioner only), none.
//   RESEND=1             don't write anything; just email the week's existing recap (to whoever EMAIL says).
//   SITE_URL             link in the email (default https://kohikori.github.io/family-pick-pool/).

import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildEmail, sendEmail} from './recap-email.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const S = require(join(root, 'docs', 'scoring.js'));
const configText = readFileSync(join(root, 'docs', 'config.js'), 'utf8');
const fromConfig = (k) => (configText.match(new RegExp(k + "\\s*:\\s*'([^']+)'")) || [])[1];

const env = process.env;
const URL_BASE = (env.SUPABASE_URL || fromConfig('supabaseUrl') || '').replace(/\/+$/, '');
const REST = env.SUPABASE_REST || URL_BASE + '/rest/v1';
const KEY = env.SUPABASE_SECRET_KEY;
const truthy = (v) => /^(1|true|yes)$/i.test(v || '');
const FORCE = truthy(env.FORCE), SKIP_SCORES = truthy(env.SKIP_SCORES);
const MODEL = env.RECAP_MODEL || 'claude-sonnet-5-5';
const PLAYER_ORDER = ['CGF', 'LPF', 'ATF', 'ASL', 'WSL', 'CGF II'];
const EMAIL = (env.EMAIL || 'all').toLowerCase(), RESEND = truthy(env.RESEND);
const SITE_URL = env.SITE_URL || 'https://kohikori.github.io/family-pick-pool/';

if (!KEY) { console.error('SUPABASE_SECRET_KEY is not set. Add it under Settings → Secrets and variables → Actions.'); process.exit(1); }

const headers = {apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json'};
async function api(path, opts = {}) {
  const r = await fetch(REST + path, {...opts, headers: {...headers, ...(opts.headers || {})}});
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
async function getAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await api(path, {headers: {Range: `${from}-${from + 999}`, 'Range-Unit': 'items'}});
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// ---------- which week ----------
async function pickSeasonAndWeek() {
  const season = Number(env.SEASON) || (await api('/seasons?select=season&order=season.desc&limit=1'))[0].season;
  const games = await api(`/games?select=id,week,week_label,kickoff,away,home,home_score,away_score,legacy_winner&season=eq.${season}&order=week`);
  let week = Number(env.WEEK) || null;
  if (!week) {
    const now = Date.now();
    const started = games.filter((g) => !g.kickoff || new Date(g.kickoff).getTime() <= now).map((g) => g.week);
    week = started.length ? Math.max(...started) : null;
  }
  return {season, week, games};
}

// ---------- ESPN scores ----------
const ESPN_FIX = {WSH: 'WAS'};
async function updateScores(season, week, games) {
  if (SKIP_SCORES || week > 18) return 0;
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;
  let data;
  try { data = await (await fetch(url)).json(); } catch (e) { console.log('ESPN unavailable:', e.message); return 0; }
  let n = 0;
  for (const ev of data.events || []) {
    const c = ev.competitions[0];
    if (!(c.status && c.status.type && c.status.type.completed)) continue;
    const side = (h) => c.competitors.find((x) => x.homeAway === h);
    const code = (x) => { const a = x.team.abbreviation.toUpperCase(); return ESPN_FIX[a] || a; };
    const away = code(side('away')), home = code(side('home'));
    const g = games.find((x) => x.week === week && x.away === away && x.home === home);
    if (!g) continue;
    const as = Number(side('away').score), hs = Number(side('home').score);
    if (g.away_score === as && g.home_score === hs) continue;
    await api(`/games?id=eq.${g.id}`, {method: 'PATCH', body: JSON.stringify({away_score: as, home_score: hs}), headers: {Prefer: 'return=minimal'}});
    n++;
  }
  return n;
}

// ---------- the week's numbers ----------
function buildFacts(rows, season, week) {
  const present = [...new Set(rows.map((r) => r.player_code))];
  const players = PLAYER_ORDER.filter((p) => present.includes(p)).concat(present.filter((p) => !PLAYER_ORDER.includes(p)));
  const wk = S.weekly(rows, players);
  const ww = wk.filter((r) => r.week === week);
  const label = (ww[0] || {}).label || 'Week ' + week;
  const rc = S.recap(rows, wk, week);
  const hist = S.rankHistory(wk, players);
  const now = hist.find((h) => h.week === week);
  const prevIdx = hist.findIndex((h) => h.week === week) - 1;
  const prev = prevIdx >= 0 ? hist[prevIdx] : null;
  const games = S.gameResults(rows, week);
  const playedPicks = new Set(rows.filter((r) => r.week === week).map((r) => r.player_code));
  const scores = ww.slice().sort((a, b) => b.points - a.points).map((r) => ({
    player: r.player, points: r.points, winners: r.winner, spreads: r.spread, over_unders: r.ou, sweeps: r.sweeps,
    season_total: r.cum, rank_after: now ? now.ranks[r.player].rank : null,
    rank_before: prev ? prev.ranks[r.player].rank : null, games_picked: r.games,
  }));
  const st = S.standings(wk.filter((r) => r.week <= week), players);
  return {
    season, week, label,
    games_final: games.filter((g) => g.final).length, games_total: games.length,
    week_scores: scores,
    top_score: rc.top, runner_up: rc.second, low_score: rc.low, sweeps: rc.sweeps,
    biggest_upset: rc.upset, lone_correct_calls: rc.lone, everyone_missed: rc.missed,
    season_leader_after_week: rc.leader,
    standings_after_week: st.map((r) => ({player: r.player, points: r.points, behind: r.behind, weeks_won: r.weeksWon})),
    players_without_picks_on_site: PLAYER_ORDER.filter((p) => !playedPicks.has(p)),
    game_results: games.map((g) => ({game: g.game, line: g.line, total: g.total, winner: g.winner, covered: g.covered, over_under: g.ou, picked_winner: g.pickedWinner})),
  };
}

// ---------- writing ----------
// ---------- storylines ----------
// Special conditions worth leading with. Each returns {key, rank, title, text} or nothing.
// history: every final pick row from all seasons: {season, week, player_code, points}.
function findStorylines(f, rows, history) {
  const out = [];
  const s = f.week_scores.filter((r) => r.games_picked > 0);
  if (!s.length) return out;
  const top = s.filter((r) => r.points === s[0].points), topNames = names(top.map((r) => r.player));
  // weekly totals per player from history, leaving out this week
  const weekly = {};
  history.forEach((r) => {
    if (r.season === f.season && r.week === f.week) return;
    const k = r.season + '|' + r.week + '|' + r.player_code;
    weekly[k] = (weekly[k] || 0) + Number(r.points || 0);
  });
  const past = Object.entries(weekly).map(([k, pts]) => { const [season, week, player] = k.split('|'); return {season: +season, week: +week, player, pts}; });
  const weekName = (r) => (r.week <= 18 ? 'Week ' + r.week : ({19: 'Wild Card weekend', 20: 'the Divisional round', 21: 'Championship weekend', 22: 'the Super Bowl'}[r.week] || 'Week ' + r.week)) + ' of ' + r.season;

  // 1. Single-week record (all seasons)
  if (past.length) {
    const best = Math.max(...past.map((r) => r.pts));
    const holders = past.filter((r) => r.pts === best);
    const was = holders.map((r) => `${r.player} in ${weekName(r)}`).join(' and ');
    const bonusNote = holders.every((r) => r.season < 2025) ? ' The old record came before sweep bonuses, which started in 2025.' : '';
    if (s[0].points > best) out.push({key: 'record', rank: 100, title: `${f.label}: ${topNames} ${top.length > 1 ? 'set' : 'sets'} a new single-week record`,
      text: `Record: ${topNames} scored ${s[0].points} points, the most in a single week in pool history. The old mark was ${best}, set by ${was}.${bonusNote}`});
    else if (s[0].points === best) out.push({key: 'record', rank: 90, title: `${f.label}: ${topNames} ${top.length > 1 ? 'tie' : 'ties'} the single-week record`,
      text: `Record: ${topNames}'s ${s[0].points} points tie the most ever scored in a single week, matching ${was}.`});
  }

  // 2 & 3. The whole pool had a big (or rough) week, compared with earlier weeks this season.
  const wk = S.weekly(rows, [...new Set(rows.map((r) => r.player_code))]).filter((r) => r.week < f.week && r.games > 0);
  if (wk.length >= 3) {
    const avg = wk.reduce((a, r) => a + r.points, 0) / wk.length;
    const perGame = wk.reduce((a, r) => a + r.points, 0) / wk.reduce((a, r) => a + r.games, 0);
    const nowPerGame = s.reduce((a, r) => a + r.points, 0) / s.reduce((a, r) => a + r.games_picked, 0);
    const combined = s.reduce((a, r) => a + r.points, 0);
    const byWeek = {}; wk.forEach((r) => { byWeek[r.week] = (byWeek[r.week] || 0) + r.points; });
    const bestWeek = Object.entries(byWeek).sort((a, b) => b[1] - a[1])[0];
    const worstWeek = Object.entries(byWeek).sort((a, b) => a[1] - b[1])[0];
    const a1 = avg.toFixed(1);
    if (s.every((r) => r.points > avg) && nowPerGame >= perGame * 1.1) {
      const seasonHigh = bestWeek && combined > bestWeek[1] ? ` The pool combined for ${combined} points, its best week of the season (the previous best was ${bestWeek[1]} in Week ${bestWeek[0]}).` : ` The pool combined for ${combined} points.`;
      out.push({key: 'pool-big', rank: 80, title: `${f.label}: a banner week for the whole pool`,
        text: `Big week for everyone: every player beat the season's average of ${a1} points a week.${seasonHigh}`});
    } else if (s.every((r) => r.points < avg) && nowPerGame <= perGame * 0.9) {
      const seasonLow = worstWeek && combined < worstWeek[1] ? ` The pool's ${combined} combined points are the fewest of any week this season.` : '';
      out.push({key: 'pool-rough', rank: 30, title: `${f.label}: the week that humbled everyone`,
        text: `Tough week all around: every player finished under the season's average of ${a1} points a week.${seasonLow}`});
    }
  }

  // 4. Personal bests (at least 5 earlier weeks on record)
  const pbs = s.map((r) => {
    const mine = past.filter((x) => x.player === r.player);
    if (mine.length < 5) return null;
    const best = Math.max(...mine.map((x) => x.pts));
    return r.points > best ? {player: r.player, points: r.points, best} : null;
  }).filter(Boolean).filter((x) => !(out.some((o) => o.key === 'record') && top.some((t) => t.player === x.player)));
  if (pbs.length) out.push({key: 'personal-best', rank: 40, title: `${f.label}: a career week for ${names(pbs.map((x) => x.player))}`,
    text: pbs.length === 1 ? `Personal best: ${pbs[0].player}'s ${pbs[0].points} points are the most they've ever scored in a week (previous best ${pbs[0].best}).`
      : `Personal bests: ${pbs.map((x) => `${x.player} with ${x.points} (previous best ${x.best})`).join('; ')}.`});

  // 5. Shake-up at the top
  const st = f.standings_after_week, leaders = st.filter((r) => r.points === st[0].points).map((r) => r.player);
  const before = f.week_scores.filter((r) => r.rank_before === 1).map((r) => r.player);
  if (leaders.length > 1) out.push({key: 'tie-top', rank: 60, title: `${f.label}: a tie at the top`,
    text: `Tied at the top: ${names(leaders)} share first place with ${st[0].points} points.`});
  else if (before.length && !before.includes(leaders[0])) {
    const next = st.find((r) => r.points < st[0].points);
    out.push({key: 'new-leader', rank: 60, title: `${f.label}: ${leaders[0]} takes over first place`,
      text: `New leader: ${leaders[0]} moves into first place with ${st[0].points} points${next ? `, ${st[0].points - next.points} ahead of ${next.player}` : ''}.`});
  }

  // 6. Hot streak: won this week and the week(s) right before
  const winnersOf = (w) => { const ws = wk.filter((r) => r.week === w); const m = Math.max(...ws.map((r) => r.points)); return ws.filter((r) => r.points === m).map((r) => r.player); };
  const weeks = [...new Set(wk.map((r) => r.week))].sort((a, b) => b - a);
  const streaks = top.map((t) => { let n = 1; for (const w of weeks) { if (winnersOf(w).includes(t.player)) n++; else break; } return {player: t.player, n}; }).filter((x) => x.n >= 2);
  if (streaks.length) { const x = streaks.sort((a, b) => b.n - a.n)[0];
    out.push({key: 'streak', rank: 50, title: `${f.label}: ${x.player} makes it ${x.n} in a row`, text: `Hot streak: ${x.player} has now won ${x.n} weeks in a row.`}); }

  return out.sort((a, b) => b.rank - a.rank);
}

function templateRecap(f) {
  const s = f.week_scores;
  if (!s.length) return {title: f.label + ' recap', body: 'No picks were recorded on the site for ' + f.label + '.'};
  const top = s.filter((r) => r.points === s[0].points);
  const second = s.find((r) => r.points < s[0].points);
  const low = s[s.length - 1];
  const climbers = s.filter((r) => r.rank_before && r.rank_after < r.rank_before).map((r) => `${r.player} (up to ${ordinal(r.rank_after)})`);
  const sliders = s.filter((r) => r.rank_before && r.rank_after > r.rank_before).map((r) => `${r.player} (down to ${ordinal(r.rank_after)})`);
  const lead = f.standings_after_week[0], next = f.standings_after_week.find((r) => r.points < lead.points);
  const p = [];
  const stories = f.storylines || [];
  if (stories.length) p.push(stories.map((x) => x.text).join(' '));
  p.push(`${names(top.map((r) => r.player))} ${top.length > 1 ? 'shared' : 'took'} ${f.label} with ${s[0].points} points` +
    (second ? `, ${s[0].points - second.points} ahead of ${second.player} (${second.points})` : '') +
    `. ${f.sweeps.startsWith('Nobody') ? 'Nobody went 3-for-3 on a single game.' : 'Most sweeps: ' + f.sweeps + '.'}`);
  let upsetText = f.biggest_upset;
  const called = (upsetText.match(/Called by (.+?)\.?$/) || [])[1];
  if (called && called.split(/\s*&\s*|,\s*/).length >= s.length) upsetText = upsetText.replace(/Called by .+$/, 'Everyone saw it coming.');
  const upset = f.biggest_upset === 'None this week' ? 'The favorites all held up straight up.' : 'Biggest upset: ' + upsetText;
  const lone = f.lone_correct_calls[0] === 'None this week' ? '' : ' Lone correct calls: ' + f.lone_correct_calls.slice(0, 3).join('; ') + (f.lone_correct_calls.length > 3 ? `, and ${f.lone_correct_calls.length - 3} more` : '') + '.';
  const missed = f.everyone_missed[0] === 'None this week' ? '' : ' Nobody saw this coming: ' + f.everyone_missed.join('; ') + '.';
  p.push(upset + lone + missed);
  p.push(`${lead.player} leads the season with ${lead.points} points` + (next ? `, ${lead.points - next.points} ahead of ${next.player}` : '') + '.' +
    (climbers.length ? ' Moving up: ' + climbers.join(', ') + '.' : '') + (sliders.length ? ' Sliding: ' + sliders.join(', ') + '.' : ''));
  if (low && low.points < s[0].points && !stories.some((x) => x.key === 'pool-big')) p.push(`A week to forget for ${low.player} (${low.points} points). There's always next week.`);
  if (f.players_without_picks_on_site.length) p.push(`No picks on the site this week for ${names(f.players_without_picks_on_site)}.`);
  const title = stories.length ? stories[0].title : `${f.label}: ${names(top.map((r) => r.player))} ${top.length > 1 ? 'share the top spot' : 'takes the week'}`;
  return {title, body: p.join('\n\n')};
}
const names = (a) => (a.length <= 2 ? a.join(' & ') : a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1]);
const ordinal = (k) => k + (k % 10 === 1 && k !== 11 ? 'st' : k % 10 === 2 && k !== 12 ? 'nd' : k % 10 === 3 && k !== 13 ? 'rd' : 'th');

async function claudeRecap(f) {
  const prompt = `You write the weekly recap for a casual family NFL pick pool. Each week every player picks, for every game, the straight-up winner, the spread winner and the over/under. One point per correct pick, plus a bonus point for getting all three right in a game (a "sweep").

Here are this week's results as JSON. Use ONLY these facts; do not invent scores, picks, stats or storylines that are not in the data.

${JSON.stringify(f, null, 1)}

Write a short, fun recap for the family:
- 3 or 4 short paragraphs, 150 to 230 words in total. Plain text, no markdown, no bullet points, at most one emoji.
- Refer to players only by their codes exactly as written (e.g. "CGF II"). Never use he, she, him, her, his or hers for a player; use their code or "they".
- If storylines is not empty, lead with them (they are the week's headline: records, everyone's big week, a new leader, streaks); otherwise lead with who won the week and by how much. Mention sweeps, the biggest upset and any lone correct call. Close with the season standings and who moved up or down.
- Light, friendly ribbing is good; nothing mean. If players_without_picks_on_site is not empty, mention briefly that their picks weren't on the site this week.
- Also write a punchy title of at most 8 words.

Reply with only a JSON object: {"title": "...", "body": "paragraph one\\n\\nparagraph two..."}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    body: JSON.stringify({model: MODEL, max_tokens: 1200, messages: [{role: 'user', content: prompt}]}),
  });
  if (!r.ok) throw new Error('Claude API ' + r.status + ' ' + (await r.text()));
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude reply had no JSON');
  const out = JSON.parse(m[0]);
  if (!out.title || !out.body) throw new Error('Claude reply missing title or body');
  if (/\b(he|she|him|her|his|hers)\b/i.test(out.body)) throw new Error('Claude reply used gendered pronouns');
  return {title: String(out.title).slice(0, 120), body: String(out.body).trim()};
}

// ---------- email ----------
async function emailRecap(season, facts, recap) {
  if (EMAIL === 'none') { console.log('Email: skipped (EMAIL=none).'); return; }
  const people = await api('/players?select=code,email,is_admin&active=is.true&email=not.is.null');
  const to = people.filter((p) => EMAIL !== 'me' || p.is_admin).map((p) => p.email).filter(Boolean);
  if (!to.length) { console.log('Email: nobody to send to (no player emails on file).'); return; }
  const players = [...new Set([...PLAYER_ORDER, ...facts.week_scores.map((r) => r.player)])];
  const msg = buildEmail({season, label: facts.label, recap, players, siteUrl: SITE_URL,
    standings: facts.standings_after_week.map((r) => ({player: r.player, points: r.points, behind: r.behind, weeksWon: r.weeks_won})),
    weekScores: facts.week_scores.filter((r) => r.games_picked > 0)});
  try {
    await sendEmail({to: to.join(', '), ...msg});
    console.log(`Email: sent "${msg.subject}" to ${to.length} ${to.length === 1 ? 'person' : 'people'} (${people.filter((p) => to.includes(p.email)).map((p) => p.code).join(', ')}).`);
  } catch (e) {
    console.error('Email failed: ' + (e.message || e));
    process.exitCode = 1;
  }
}

// ---------- main ----------
(async () => {
  const {season, week, games} = await pickSeasonAndWeek();
  if (!week) { console.log(`No ${season} games have started yet. Nothing to do.`); return; }

  const loadFacts = async () => {
    const rows = await getAll(`/pick_scores?select=*&season=eq.${season}&order=week,game_no`);
    rows.forEach((r) => { r.week = Number(r.week); r.game_no = Number(r.game_no); });
    const facts = buildFacts(rows, season, week);
    try {
      const history = await getAll('/pick_scores?select=season,week,player_code,points&is_final=is.true&order=season,week,game_no');
      history.forEach((r) => { r.season = Number(r.season); r.week = Number(r.week); });
      facts.storylines = findStorylines(facts, rows.filter((r) => r.week <= week), history);
      if (facts.storylines.length) console.log('Storylines: ' + facts.storylines.map((x) => x.key).join(', '));
    } catch (e) { console.log('Storylines skipped: ' + e.message); facts.storylines = []; }
    return facts;
  };

  if (RESEND) {
    const [saved] = await api(`/recaps?select=title,body_md&season=eq.${season}&week=eq.${week}`);
    if (!saved) { console.log(`No recap saved for ${season} week ${week}, so nothing to resend.`); return; }
    await emailRecap(season, await loadFacts(), {title: saved.title, body: saved.body_md});
    return;
  }

  const n = await updateScores(season, week, games);
  if (n) console.log(`Entered ${n} final score(s) from ESPN for week ${week}.`);

  const existing = await api(`/recaps?select=week&season=eq.${season}&week=eq.${week}`);
  if (existing.length && !FORCE) { console.log(`A recap for ${season} week ${week} already exists. Use FORCE=1 to rewrite it.`); return; }

  const facts = await loadFacts();
  const status = await api(`/game_results?select=id,is_final&season=eq.${season}&week=eq.${week}`);
  facts.games_total = status.length;
  facts.games_final = status.filter((g) => g.is_final).length;
  if (facts.games_final < facts.games_total && !FORCE) {
    console.log(`Week ${week}: ${facts.games_final} of ${facts.games_total} games final. Waiting for the rest; a later run will try again.`);
    return;
  }
  if (!facts.week_scores.some((r) => r.games_picked > 0)) { console.log(`No scored picks for week ${week}. Nothing to recap.`); return; }

  let recap, by = 'template';
  if (env.ANTHROPIC_API_KEY) {
    try { recap = await claudeRecap(facts); by = 'claude'; }
    catch (e) { console.log('Claude recap failed, using the built-in writer instead:', e.message); }
  }
  if (!recap) recap = templateRecap(facts);

  await api('/recaps?on_conflict=season,week', {
    method: 'POST',
    headers: {Prefer: 'resolution=merge-duplicates,return=minimal'},
    body: JSON.stringify({season, week, title: recap.title, body_md: recap.body, created_at: new Date().toISOString()}),
  });
  console.log(`Saved ${season} ${facts.label} recap (written by ${by}):\n\n${recap.title}\n\n${recap.body}\n`);
  await emailRecap(season, facts, recap);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

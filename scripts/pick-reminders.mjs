// Family Pick Pool: pick reminder emails.
// Runs every 15 minutes from an outside timer (cron-job.org → GitHub Actions, see
// .github/workflows/pick-reminders.yml). Each run:
//   1. Finds games kicking off within the next hour (REMIND_HOURS, default 1).
//   2. Emails each player who has no pick yet for one of them. The email lists every game they
//      still need that kicks off in the next LOOKAHEAD_HOURS (default 14), so a whole Sunday
//      slate comes in one email instead of one per time slot.
//   3. Emails the commissioner if any of those games has no line yet (nobody can pick it).
// A game is only ever reminded once per player, so extra or overlapping runs are harmless.
// Sheet players are covered too: their sheet picks reach the site within 15 minutes.
//
// Settings (environment variables):
//   SUPABASE_SECRET_KEY              required (GitHub secret).
//   GMAIL_USER, GMAIL_APP_PASSWORD   the pool Gmail account (GitHub secrets).
//   REMIND_HOURS     how close to kickoff before a reminder goes out (default 1).
//   LOOKAHEAD_HOURS  how far ahead one email gathers games (default 14).
//   ONLY             optional player code: only remind this player (for testing, e.g. "CGF II").
//   DRY_RUN=1        say who would be emailed, but send nothing and record nothing.
//   SITE_URL         link in the email (default https://kohikori.github.io/family-pick-pool/).

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sendEmail} from './recap-email.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configText = readFileSync(join(root, 'docs', 'config.js'), 'utf8');
const fromConfig = (k) => (configText.match(new RegExp(k + "\\s*:\\s*'([^']+)'")) || [])[1];

const env = process.env;
const URL_BASE = (env.SUPABASE_URL || fromConfig('supabaseUrl') || '').replace(/\/+$/, '');
const REST = env.SUPABASE_REST || URL_BASE + '/rest/v1';
const KEY = env.SUPABASE_SECRET_KEY;
const truthy = (v) => /^(1|true|yes)$/i.test(v || '');
const DRY = truthy(env.DRY_RUN);
const REMIND_MS = (Number(env.REMIND_HOURS) || 1) * 3600e3;
const LOOKAHEAD_MS = Math.max(REMIND_MS, (Number(env.LOOKAHEAD_HOURS) || 14) * 3600e3);
const ONLY = (env.ONLY || '').trim();
const SITE_URL = env.SITE_URL || 'https://kohikori.github.io/family-pick-pool/';
const NOW = env.NOW ? new Date(env.NOW).getTime() : Date.now();   // NOW is for testing only

if (!KEY) { console.error('SUPABASE_SECRET_KEY is not set. Add it under Settings → Secrets and variables → Actions.'); process.exit(1); }

const headers = {apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json'};
async function api(path, opts = {}) {
  const r = await fetch(REST + path, {...opts, headers: {...headers, ...(opts.headers || {})}});
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const C = {green: '#1d6b45', ink: '#14201a', muted: '#6b766f', line: '#dfe3dd', soft: '#f3f6f2'};
const fmt = (iso, opts) => new Date(iso).toLocaleString('en-US', {timeZone: 'America/New_York', ...opts});
const when = (iso) => fmt(iso, {weekday: 'short', hour: 'numeric', minute: '2-digit'}) + ' ET';
const timeOnly = (iso) => fmt(iso, {hour: 'numeric', minute: '2-digit'}) + ' ET';
const hasLine = (g) => g.favorite && g.spread != null && g.total != null;

function buildReminder(player, games, weekLabel) {
  const first = games[0];
  const n = games.length;
  const subject = `⏰ ${player}: ${n === 1 ? `no pick yet for ${first.away} @ ${first.home}` : `${n} games still need picks`} · kickoff ${timeOnly(first.kickoff)}`;
  const url = SITE_URL.replace(/\/+$/, '/') + '#picks';
  const rows = games.map((g) => `<tr><td style="padding:7px 8px;border-bottom:1px solid ${C.line};font-weight:700">${esc(g.away)} @ ${esc(g.home)}</td>` +
    `<td style="padding:7px 8px;border-bottom:1px solid ${C.line};text-align:right;color:${C.muted}">${esc(when(g.kickoff))}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:${C.soft};">
<div style="max-width:560px;margin:0 auto;padding:20px 16px;font:15px/1.5 Arial,Helvetica,sans-serif;color:${C.ink}">
  <div style="font:600 11px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:${C.green}">Family Pick Pool · ${esc(weekLabel)}</div>
  <h1 style="font:700 22px/1.25 Arial,sans-serif;margin:6px 0 10px">Picks needed, <b>${esc(player)}</b></h1>
  <p style="margin:0 0 12px">${n === 1 ? 'This game kicks off soon and you don’t have a pick in yet.' : 'These games kick off soon and you don’t have picks in yet.'} Picks lock at kickoff.</p>
  <table cellspacing="0" style="width:100%;border-collapse:collapse;background:#fff;border:1px solid ${C.line};border-radius:10px;font-size:14px">${rows}</table>
  <p style="margin:20px 0"><a href="${esc(url)}" style="display:inline-block;background:${C.green};color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Make my picks</a></p>
  <p style="color:${C.muted};font-size:12px;margin:0">Already picked in the sheet? It can take up to 15 minutes to reach the site, so you can ignore this.</p>
</div></body></html>`;
  const text = [`Picks needed, ${player} (${weekLabel})`, '', 'No pick yet for:', ...games.map((g) => `  ${g.away} @ ${g.home}  ${when(g.kickoff)}`), '',
    'Picks lock at kickoff: ' + url, '', 'Already picked in the sheet? It can take up to 15 minutes to reach the site.'].join('\n');
  return {subject, html, text};
}

function buildLinesAlert(games, weekLabel) {
  const list = games.map((g) => `${g.away} @ ${g.home} (${when(g.kickoff)})`);
  const url = SITE_URL.replace(/\/+$/, '/') + '#lines';
  const subject = `⚠️ Lines not posted: ${games.length === 1 ? list[0] : games.length + ' games kick off soon'}`;
  const html = `<!doctype html><html><body style="margin:0;background:${C.soft};">
<div style="max-width:560px;margin:0 auto;padding:20px 16px;font:15px/1.5 Arial,Helvetica,sans-serif;color:${C.ink}">
  <div style="font:600 11px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:${C.green}">Family Pick Pool · ${esc(weekLabel)}</div>
  <h1 style="font:700 22px/1.25 Arial,sans-serif;margin:6px 0 10px">Lines aren’t posted yet</h1>
  <p style="margin:0 0 8px">Nobody can pick these games until they have a favorite, spread and total:</p>
  <ul style="margin:0 0 12px;padding-left:20px">${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p style="margin:20px 0"><a href="${esc(url)}" style="display:inline-block;background:${C.green};color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Set lines</a></p>
</div></body></html>`;
  return {subject, html, text: ['Lines aren’t posted yet for:', ...list.map((l) => '  ' + l), '', 'Set lines: ' + url].join('\n')};
}

async function main() {
  const from = new Date(NOW).toISOString(), to = new Date(NOW + LOOKAHEAD_MS).toISOString();
  const games = await api(`/games?select=id,season,week,week_label,away,home,kickoff,favorite,spread,total` +
    `&kickoff=gt.${encodeURIComponent(from)}&kickoff=lte.${encodeURIComponent(to)}&order=kickoff,game_no`);
  const soon = (g) => new Date(g.kickoff).getTime() <= NOW + REMIND_MS;
  if (!games.some(soon)) { console.log(`No games kick off in the next ${REMIND_MS / 3600e3} hours. Nothing to do.`); return; }

  const ids = games.map((g) => g.id).join(',');
  const [people, picks, sent] = await Promise.all([
    api('/players?select=code,email,is_admin&active=is.true'),
    api(`/picks?select=player_code,game_id&game_id=in.(${ids})`),
    api(`/pick_reminders?select=kind,player_code,game_id&game_id=in.(${ids})`),
  ]);
  const picked = new Set(picks.map((p) => p.player_code + '|' + p.game_id));
  const already = new Set(sent.map((s) => s.kind + '|' + s.player_code + '|' + s.game_id));
  const record = [];
  let emails = 0;

  // Players: anyone missing a pick for a game kicking off soon gets one email covering
  // every game they still need in the lookahead window.
  const pickable = games.filter(hasLine);
  for (const p of people) {
    if (ONLY && p.code !== ONLY) continue;
    const missing = pickable.filter((g) => !picked.has(p.code + '|' + g.id) && !already.has('picks|' + p.code + '|' + g.id));
    if (!missing.some(soon)) continue;
    if (!p.email) { console.log(`${p.code}: missing ${missing.length} pick(s) but has no email on file.`); continue; }
    const msg = buildReminder(p.code, missing, missing[0].week_label);
    console.log(`${p.code}: ${DRY ? 'would email' : 'emailing'} about ${missing.map((g) => g.away + '@' + g.home).join(', ')}.`);
    if (!DRY) {
      try { await sendEmail({to: p.email, ...msg}); emails++; }
      catch (e) { console.error(`${p.code}: email failed: ${e.message}`); continue; }
      record.push(...missing.map((g) => ({kind: 'picks', player_code: p.code, game_id: g.id})));
    }
  }

  // Commissioner: games kicking off soon with no line.
  const noLine = games.filter((g) => !hasLine(g) && soon(g));
  for (const a of people.filter((p) => p.is_admin && p.email && (!ONLY || p.code === ONLY))) {
    const todo = noLine.filter((g) => !already.has('lines|' + a.code + '|' + g.id));
    if (!todo.length) continue;
    console.log(`${a.code} (commissioner): ${DRY ? 'would email' : 'emailing'} about missing lines for ${todo.map((g) => g.away + '@' + g.home).join(', ')}.`);
    if (!DRY) {
      try { await sendEmail({to: a.email, ...buildLinesAlert(todo, todo[0].week_label)}); emails++; }
      catch (e) { console.error(`${a.code}: email failed: ${e.message}`); continue; }
      record.push(...todo.map((g) => ({kind: 'lines', player_code: a.code, game_id: g.id})));
    }
  }

  if (record.length) {
    await api('/pick_reminders', {method: 'POST', body: JSON.stringify(record),
      headers: {Prefer: 'resolution=ignore-duplicates,return=minimal'}});
  }
  console.log(DRY ? 'Dry run: nothing sent or recorded.' : `Done. ${emails} email(s) sent.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

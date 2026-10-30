// Family Pick Pool: the weekly recap email, sent from the pool Gmail account.
// Used by weekly-recap.mjs. Needs GMAIL_USER and GMAIL_APP_PASSWORD (GitHub secrets).

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const C = {green: '#1d6b45', ink: '#14201a', muted: '#6b766f', line: '#dfe3dd', soft: '#f3f6f2'};

// Same formatting as the site: one sentence per line, "Label:" call-outs underlined,
// player codes bold, "A; B; C" lists as bullets.
function formatBody(body, players) {
  const codes = players.slice().sort((a, b) => b.length - a.length).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const codeRe = new RegExp('(^|[^A-Za-z])(' + codes.join('|') + ')(?![A-Za-z])', 'g');
  const rich = (s) => esc(s).replace(codeRe, (m, pre, c) => pre + '<b>' + c + '</b>');
  const line = (sent) => {
    const m = sent.match(/^([A-Z][A-Za-z' ]{2,30}):\s+(.*)$/);
    if (!m) return `<div style="margin:0 0 4px">${rich(sent)}</div>`;
    const items = m[2].replace(/\.$/, '').split(/;\s+/);
    const label = `<u style="font-weight:600">${esc(m[1])}</u>: `;
    if (items.length < 2) return `<div style="margin:0 0 4px">${label}${rich(m[2])}</div>`;
    return `<div style="margin:0 0 4px">${label}<ul style="margin:4px 0 0;padding-left:20px">${items.map((i) => `<li>${rich(i.replace(/^and\s+/, ''))}</li>`).join('')}</ul></div>`;
  };
  return String(body || '').split(/\n\s*\n/).filter((p) => p.trim()).map((p) =>
    `<div style="margin:0 0 14px">${p.replace(/[*_#>`]/g, '').trim().split(/(?<=[.!?])\s+(?=[A-Z(])/).map(line).join('')}</div>`).join('');
}

export function buildEmail({season, label, recap, standings, weekScores, siteUrl, players}) {
  const url = siteUrl.replace(/\/+$/, '/') + '#week';
  const th = (t, right) => `<th style="text-align:${right ? 'right' : 'left'};font:600 11px Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};padding:6px 8px;border-bottom:1px solid ${C.line}">${t}</th>`;
  const td = (t, right, bold) => `<td style="text-align:${right ? 'right' : 'left'};padding:6px 8px;border-bottom:1px solid ${C.line};${bold ? 'font-weight:700;' : ''}">${t}</td>`;
  const medal = (i) => ['🥇', '🥈', '🥉'][i] || String(i + 1);
  const rankOf = (list, k) => list.map((r) => 1 + list.filter((q) => q[k] > r[k]).length);
  const sr = rankOf(standings, 'points');
  const standingsRows = standings.map((r, i) => `<tr>${td(sr[i] <= 3 ? medal(sr[i] - 1) : sr[i])}${td(esc(r.player), false, true)}${td(r.points, true, true)}${td(r.behind ? r.behind : '–', true)}${td(r.weeksWon, true)}</tr>`).join('');
  const wr = rankOf(weekScores, 'points');
  const weekRows = weekScores.map((r, i) => `<tr>${td(wr[i])}${td(esc(r.player), false, true)}${td(r.points, true, true)}${td(r.sweeps, true)}</tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:${C.soft};">
<div style="max-width:600px;margin:0 auto;padding:20px 16px;font:15px/1.5 Arial,Helvetica,sans-serif;color:${C.ink}">
  <div style="font:600 11px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:${C.green}">Family Pick Pool · ${season} · ${esc(label)}</div>
  <h1 style="font:700 24px/1.2 Arial,sans-serif;margin:6px 0 14px">${esc(recap.title)}</h1>
  <div style="background:#fff;border:1px solid ${C.line};border-left:4px solid ${C.green};border-radius:10px;padding:16px 18px">${formatBody(recap.body, players)}</div>
  <h2 style="font:700 17px Arial,sans-serif;margin:22px 0 6px">${esc(label)} scores</h2>
  <table cellspacing="0" style="width:100%;border-collapse:collapse;background:#fff;border:1px solid ${C.line};border-radius:10px;font-size:14px">
    <tr>${th('#')}${th('Player')}${th('Points', 1)}${th('Sweeps', 1)}</tr>${weekRows}</table>
  <h2 style="font:700 17px Arial,sans-serif;margin:22px 0 6px">Season standings</h2>
  <table cellspacing="0" style="width:100%;border-collapse:collapse;background:#fff;border:1px solid ${C.line};border-radius:10px;font-size:14px">
    <tr>${th('Rank')}${th('Player')}${th('Points', 1)}${th('Behind', 1)}${th('Weeks won', 1)}</tr>${standingsRows}</table>
  <p style="margin:22px 0"><a href="${esc(url)}" style="display:inline-block;background:${C.green};color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">See the full week on the site</a></p>
  <p style="color:${C.muted};font-size:12px;margin:0">Sent automatically by the Family Pick Pool every Tuesday after Monday Night Football.</p>
</div></body></html>`;
  const text = [`FAMILY PICK POOL · ${season} · ${label}`, '', recap.title, '',
    String(recap.body).split(/\n\s*\n/).map((p) => p.trim().split(/(?<=[.!?])\s+(?=[A-Z(])/).join('\n')).join('\n\n'), '',
    `${label} scores:`, ...weekScores.map((r, i) => `  ${wr[i]}. ${r.player}  ${r.points} pts`), '',
    'Season standings:', ...standings.map((r, i) => `  ${sr[i]}. ${r.player}  ${r.points}${r.behind ? ` (−${r.behind})` : ''}`), '',
    'Full week: ' + url].join('\n');
  return {subject: `🏈 ${recap.title}`, html, text};
}

export async function sendEmail({to, subject, html, text}) {
  if (process.env.EMAIL_DRY_RUN) {   // testing: write the email to a file instead of sending
    const {writeFileSync} = await import('node:fs');
    writeFileSync(process.env.EMAIL_DRY_RUN, html); writeFileSync(process.env.EMAIL_DRY_RUN + '.txt', 'To: ' + to + '\nSubject: ' + subject + '\n\n' + text);
    return {};
  }
  const user = process.env.GMAIL_USER, pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD secrets are not set');
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({host: 'smtp.gmail.com', port: 465, secure: true, auth: {user, pass}});
  return t.sendMail({from: `"Family Pick Pool" <${user}>`, to, subject, html, text});
}

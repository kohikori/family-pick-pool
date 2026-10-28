// Pure functions that turn pick rows (from the pick_scores view) into standings, recaps and stats.
// No page code here, so it can be tested on its own:  node tests/scoring.test.js
(function (root) {
  const num = (v) => (v == null ? 0 : Number(v));
  const join = (arr) => arr.join(' & ');

  function weeksOf(rows) {
    const m = new Map();
    rows.forEach((r) => m.set(r.week, r.week_label));
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([week, label]) => ({week, label}));
  }

  // Points per player per week, plus a running total.
  function weekly(rows, players) {
    const weeks = weeksOf(rows);
    const out = [];
    for (const p of players) {
      let cum = 0;
      for (const {week, label} of weeks) {
        const rs = rows.filter((r) => r.player_code === p && r.week === week && r.is_final);
        const s = (k) => rs.reduce((t, r) => t + num(r[k]), 0);
        const points = s('points');
        cum += points;
        out.push({week, label, player: p, winner: s('winner_pt'), spread: s('spread_pt'), ou: s('ou_pt'), sweeps: s('sweep'), points, cum, games: rs.length});
      }
    }
    return out;
  }

  function standings(wk, players) {
    const weeks = [...new Set(wk.map((r) => r.week))];
    const won = Object.fromEntries(players.map((p) => [p, 0]));
    for (const w of weeks) {
      const rs = wk.filter((r) => r.week === w && r.games > 0);
      if (!rs.length) continue;
      const top = Math.max(...rs.map((r) => r.points));
      rs.filter((r) => r.points === top).forEach((r) => { won[r.player] += 1; });
    }
    const rows = players.map((p) => {
      const rs = wk.filter((r) => r.player === p);
      const s = (k) => rs.reduce((t, r) => t + r[k], 0);
      const games = s('games');
      const acc = (v) => (games ? v / games : null);
      return {player: p, points: s('points'), winner: s('winner'), spread: s('spread'), ou: s('ou'), sweeps: s('sweeps'), weeksWon: won[p], games,
        accuracy: games ? (s('winner') + s('spread') + s('ou')) / (3 * games) : null, winnerAcc: acc(s('winner')), spreadAcc: acc(s('spread')), ouAcc: acc(s('ou')),
        form: rs.filter((r) => r.games > 0).map((r) => r.points)};
    }).sort((a, b) => b.points - a.points || b.sweeps - a.sweeps);
    const lead = rows.length ? rows[0].points : 0;
    return rows.map((r) => ({...r, behind: lead - r.points}));
  }

  function gamesOf(rows, week) {
    const g = new Map();
    rows.filter((r) => r.week === week).forEach((r) => {
      if (!g.has(r.game_id)) g.set(r.game_id, []);
      g.get(r.game_id).push(r);
    });
    return [...g.values()].sort((a, b) => a[0].game_no - b[0].game_no);
  }

  // Facts for one week's recap.
  function recap(rows, wk, week) {
    const games = gamesOf(rows, week);
    const final = games.filter((g) => g[0].is_final);
    const ww = wk.filter((r) => r.week === week);
    const status = final.length + ' of ' + games.length + ' games final';
    if (!final.length) return {status, empty: true};
    const pts = [...new Set(ww.map((r) => r.points))].sort((a, b) => b - a);
    const at = (v) => ww.filter((r) => r.points === v).map((r) => r.player);
    const sw = Math.max(...ww.map((r) => r.sweeps));
    const lone = [];
    const missed = [];
    let upset = null;
    for (const g of final) {
      const g0 = g[0];
      const one = (k, label) => {
        const ok = g.filter((r) => num(r[k]) === 1);
        if (ok.length === 1 && g.length > 2) lone.push(ok[0].player_code + ': ' + label(ok[0]) + ' (' + g0.away + ' @ ' + g0.home + ')');
      };
      one('winner_pt', (r) => r.pick_winner + ' to win');
      one('spread_pt', (r) => r.pick_spread + ' to cover');
      one('ou_pt', (r) => r.pick_ou);
      if (g0.winner !== 'Tie' && g.every((r) => num(r.winner_pt) === 0)) missed.push(g0.winner + ' won ' + g0.away + ' @ ' + g0.home);
      if (g0.winner && g0.winner !== 'Tie' && g0.favorite && g0.winner !== g0.favorite && (!upset || num(g0.spread) > num(upset[0].spread))) upset = g;
    }
    let upsetText = 'None this week';
    if (upset) {
      const u = upset[0];
      const callers = upset.filter((r) => r.pick_winner === u.winner).map((r) => r.player_code);
      upsetText = u.winner + ' won as a ' + num(u.spread) + '-point underdog (' + u.away + ' @ ' + u.home + '). ' + (callers.length ? 'Called by ' + join(callers) + '.' : 'Nobody called it.');
    }
    const best = Math.max(...ww.map((r) => r.cum));
    return {
      status,
      top: join(at(pts[0])) + ', ' + pts[0] + ' points',
      second: pts.length > 1 ? join(at(pts[1])) + ', ' + pts[1] + ' points' : '–',
      low: join(at(pts[pts.length - 1])) + ', ' + pts[pts.length - 1] + ' points',
      sweeps: sw > 0 ? join(ww.filter((r) => r.sweeps === sw).map((r) => r.player)) + ', ' + sw + (sw === 1 ? ' sweep' : ' sweeps') : 'Nobody swept a game',
      upset: upsetText,
      lone: lone.length ? lone : ['None this week'],
      missed: missed.length ? missed : ['None this week'],
      leader: join(ww.filter((r) => r.cum === best).map((r) => r.player)) + ', ' + best + ' points',
    };
  }

  // One row per game in a week with each player's three picks marked.
  function grid(rows, week, players) {
    const mark = (r, k) => (!r.is_final ? '·' : num(r[k]) === 1 ? '✓' : '✗');
    return gamesOf(rows, week).map((g) => {
      const g0 = g[0];
      const out = {
        game: g0.away + ' @ ' + g0.home,
        line: g0.favorite ? g0.favorite + ' −' + num(g0.spread) + ', ' + num(g0.total) : 'No line yet',
        result: g0.is_final ? g0.winner + (g0.winner === 'Tie' ? '' : ' won') + ', ' + (g0.covered === 'Push' ? 'push' : g0.covered + ' covered') + ', ' + g0.over_under : 'Not final',
        picks: {},
      };
      for (const p of players) {
        const r = g.find((x) => x.player_code === p);
        out.picks[p] = r ? [[r.pick_winner, mark(r, 'winner_pt')], [r.pick_spread, mark(r, 'spread_pt')], [r.pick_ou === 'Over' ? 'O' : 'U', mark(r, 'ou_pt')]] : null;
      }
      return out;
    });
  }

  function habits(rows, wk, players) {
    const fin = rows.filter((r) => r.is_final);
    const side = {};
    fin.forEach((r) => { const k = r.game_id + '|' + r.pick_spread; side[k] = (side[k] || 0) + 1; });
    const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');
    const rec = (rs, k, push) => {
      const w = rs.filter((r) => num(r[k]) === 1).length;
      const l = rs.filter((r) => num(r[k]) === 0 && !push(r)).length;
      return w + '–' + l;
    };
    const tie = (r) => r.winner === 'Tie';
    const pushS = (r) => r.covered === 'Push';
    const pushO = (r) => r.over_under === 'Push';
    return players.map((p) => {
      const rs = fin.filter((r) => r.player_code === p);
      const hit = (k) => rs.filter((r) => num(r[k]) === 1).length;
      const ups = rs.filter((r) => r.favorite && r.pick_winner !== r.favorite);
      const lay = rs.filter((r) => num(r.spread) >= 7 && r.pick_spread === r.favorite);
      const solo = rs.filter((r) => side[r.game_id + '|' + r.pick_spread] === 1);
      const mine = wk.filter((r) => r.player === p && r.games > 0);
      const bw = mine.reduce((b, r) => (!b || r.points > b.points ? r : b), null);
      return {
        player: p,
        winner: pct(hit('winner_pt'), rs.filter((r) => !tie(r)).length),
        spread: pct(hit('spread_pt'), rs.filter((r) => !pushS(r)).length),
        ou: pct(hit('ou_pt'), rs.filter((r) => !pushO(r)).length),
        upsets: rec(ups, 'winner_pt', tie),
        lay7: rec(lay, 'spread_pt', pushS),
        over: pct(rs.filter((r) => r.pick_ou === 'Over').length, rs.length),
        solo: rec(solo, 'spread_pt', pushS),
        best: bw ? bw.points + ' (' + bw.label + ')' : '–',
      };
    });
  }

  // Shared ranks: 1, 2, 2, 4 ...
  function ranks(list, key) {
    return list.map((r) => 1 + list.filter((q) => q[key] > r[key]).length);
  }

  // Best single-week scores this season, highest first, with their pick breakdown.
  function records(wk) {
    return wk.filter((r) => r.games > 0).slice().sort((a, b) => b.points - a.points || b.sweeps - a.sweeps || a.week - b.week);
  }

  // One row per game in a week: line, result and how many players picked the winner.
  function gameResults(rows, week) {
    return gamesOf(rows, week).map((g) => {
      const g0 = g[0];
      return {
        game: g0.away + ' @ ' + g0.home,
        line: g0.favorite ? g0.favorite + ' −' + num(g0.spread) : '–',
        total: g0.total != null ? num(g0.total) : '–',
        final: !!g0.is_final,
        winner: g0.is_final ? g0.winner : '',
        covered: g0.is_final ? g0.covered : '',
        ou: g0.is_final ? g0.over_under : '',
        pickedWinner: g0.is_final && g0.winner !== 'Tie' ? g.filter((r) => r.pick_winner === g0.winner).length + ' of ' + g.length : '',
      };
    });
  }

  const api = {weeksOf, weekly, standings, recap, grid, habits, ranks, records, gameResults};
  if (typeof module !== 'undefined') module.exports = api;
  else root.Scoring = api;
})(this);

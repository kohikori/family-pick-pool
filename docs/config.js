// Supabase connection for the Family Pick Pool site.
// Both values are meant to be public; the database's security rules protect the data.
// NEVER put the secret key (sb_secret_...) here: this file is published on the web.
window.POOL_CONFIG = {
  supabaseUrl: 'https://okqordpqamfmamymspuu.supabase.co',
  supabaseAnonKey: 'sb_publishable_qvwgLUhLhZlI7dXoVtux4Q_slIaepNA',
  defaultSeason: 2026,
  players: ['CGF', 'LPF', 'ATF', 'ASL', 'WSL', 'CGF II'],
  // Players whose title shows as "Sweep queen" (a tie between a queen and a king shows "Sweep royalty").
  sweepQueens: ['ATF', 'LPF'],
};

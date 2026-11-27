// App configuration.
//
// spotifyClientId: the Client ID of your Spotify app (developer.spotify.com/dashboard).
// It is NOT a secret — this app uses the Authorization Code + PKCE flow, which never
// needs a client secret — so it is fine to commit it here. If left empty, the app
// shows a setup screen where the Client ID can be pasted and saved in the browser.
export const CONFIG = {
  spotifyClientId: '',

  scopes: [
    'user-read-currently-playing',
    'user-read-playback-state',
    'user-modify-playback-state', // play/pause/skip/seek (Spotify Premium only)
  ],

  // How often to ask Spotify what is playing. Between polls the playback position is
  // interpolated locally, and sync.js decides which reports to follow, so more frequent
  // polling means quicker catch-up rather than more jumps. Each request counts toward the
  // Spotify app's rate limit (shared by everyone using this Client ID); on a 429 the app
  // backs off for as long as Spotify asks.
  // Faster than once a second gets the app turned away by Spotify (429), which also made
  // the play/skip/seek controls fail, so don't go below 1000 while playing.
  pollMs: {
    playing: 1000,
    paused: 2000,
    idle: 3000,
    hidden: 15000,
  },

  // Optional backup lyrics from QQ Music, for songs LRCLIB has no timed lyrics for (mostly
  // Chinese ones). QQ Music can't be asked from a web page directly, so this is the address
  // of your own copy of relay/qq-lyrics-worker.js (see README, "QQ Music backup"), e.g.
  // 'https://qq-lyrics.yourname.workers.dev'. Leave empty to use LRCLIB only.
  lyricsRelay: '',

  // Timed lyrics from NetEase Cloud Music (网易云音乐), for Chinese songs. NetEase can't be
  // asked from a web page either; this is a public relay run by a third party (GD Studio),
  // so it needs no setup but may be slow or disappear. Empty turns it off.
  neteaseApi: 'https://music-api.gdstudio.xyz/api.php',

  // For songs with Chinese (or Japanese/Korean) names, ask QQ Music / NetEase first and
  // LRCLIB only when they have no timed lyrics. Other songs always ask LRCLIB first.
  // false: always LRCLIB first.
  chineseSourcesFirst: true,

  lrclibBase: 'https://lrclib.net',
  // LRCLIB asks clients to identify themselves. Browsers can't set User-Agent, so
  // this goes in the Lrclib-Client header. Feel free to add your site's URL.
  lrclibClient: 'tesla-lyrics-web v1.0',
};

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

  // How often to ask Spotify what is playing. Between polls the playback position
  // is interpolated locally, so lyrics stay smooth.
  pollMs: {
    playing: 2000,
    paused: 5000,
    idle: 5000,
    hidden: 15000,
  },

  lrclibBase: 'https://lrclib.net',
  // LRCLIB asks clients to identify themselves. Browsers can't set User-Agent, so
  // this goes in the Lrclib-Client header. Feel free to add your site's URL.
  lrclibClient: 'tesla-lyrics-web v1.0',
};

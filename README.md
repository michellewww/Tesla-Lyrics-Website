# Tesla Lyrics

Live, synced lyrics for whatever is playing on your Spotify, made for a car touchscreen
(and it works fine on a laptop or phone too). It is a static site hosted on GitHub Pages:
no server and no client secret.

**Live site:** https://michellewww.github.io/Tesla-Lyrics-Website/ (once Pages is enabled, see below)
**Try it without Spotify:** add `?demo` to the URL.

## Features

- **Karaoke-style, character-by-character highlighting.** It uses real word timings when LRCLIB has them (its
  "Lyricsfile" format or enhanced LRC). Otherwise it estimates timing inside each line, splitting Chinese,
  Japanese and Korean text per character and Latin text per word.
- **Line sync that stays smooth.** It polls Spotify every 2 s and interpolates the position locally every frame.
- **Tap any line to jump there.** Also play/pause, previous/next, and a seek bar.
- **Adjustments:** text size, timing offset (±0.1 s / ±0.5 s steps), left or centered alignment, karaoke on/off,
  show translations, highlight colour (default, album colour, green, gold, pink), background (blurred cover or
  album colour), full screen.
- **Light/dark mode follows the system automatically**, with a manual Auto / Light / Dark override for browsers
  that don't report it (some in-car browsers).
- **English and Simplified Chinese UI.** It picks the language from the browser, and you can change it in Settings.
  Chinese lyrics get proper CJK fonts and `lang` tags, and bilingual LRC files show the translation under each line.
- Handles the edge cases: nothing playing, ads, podcasts, instrumental tracks, unsynced lyrics, no lyrics found,
  rate limits, expired logins and flaky connections.

## How it works

```
Spotify Web API ──(PKCE OAuth, every 2s)──▶ currently-playing ─┐
                                                               ├─▶ PlaybackClock (interpolates position)
LRCLIB ──(get → search → free-text search)──▶ lyrics ──────────┤
                                                               └─▶ rAF loop: active line + per-character fill
```

| File | What it does |
| --- | --- |
| `public/js/auth.js` | Authorization Code + PKCE login, token refresh (single-flight), logout |
| `public/js/spotify.js` | `currently-playing`, play/pause/next/previous/seek; 401 → refresh + retry, 429 → back off |
| `public/js/clock.js` | Interpolates playback position between polls; ignores sub-250 ms network jitter |
| `public/js/lyrics.js` | LRCLIB lookup with fallbacks, picks Lyricsfile → LRC → plain, caches in localStorage |
| `public/js/lrc.js` | LRC parser (multi-timestamp, `[offset]`, enhanced word tags, translations), Lyricsfile parser |
| `public/js/yaml.js` | Tiny YAML-subset parser for LRCLIB's Lyricsfile |
| `public/js/karaoke.js` | Splits a line into timed segments (exact or estimated) for the character fill |
| `public/js/match.js` | Cleans Spotify titles ("- Remastered 2011", "(feat. X)") and picks the best search result |
| `public/js/i18n.js` | English / 简体中文 strings |
| `public/js/app.js` | UI wiring, polling loop, rendering |

Lyrics come from [LRCLIB](https://lrclib.net), a free, open, CORS-enabled lyrics database that needs no API key.
Spotify's own lyrics are not available through its public API.

## Setup

### 1. Create a Spotify app (one time)

1. Go to <https://developer.spotify.com/dashboard> and click **Create app** (any name and description).
2. Under **Redirect URIs** add both of these (they must match exactly, including the trailing slash):
   - `https://michellewww.github.io/Tesla-Lyrics-Website/`
   - `http://127.0.0.1:5173/` (for local testing; Spotify no longer accepts `localhost`)
3. Under **Which API/SDKs are you planning to use?** tick **Web API**, then save.
4. Copy the **Client ID**. It is not secret, since PKCE never uses the client secret.

Spotify's Development Mode rules (as of 2026): the app owner needs **Spotify Premium**, and up to **5 users** can
use the app. Add anyone else (by their Spotify email) under the app's **User Management** tab. Playback controls
(play/pause/skip/seek) need Premium; showing lyrics doesn't.

### 2. Configure the Client ID

Pick one:
- **Recommended:** put it in `public/js/config.js` (`spotifyClientId: '…'`) and push. Everyone using the site, including
  the car, skips the setup screen.
- Or leave it empty and paste it into the setup screen the first time you open the site. It is saved in that browser only.

### 3. Turn on GitHub Pages

In the repo go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. Every push to `main`
then runs the tests and deploys the `public/` folder (`.github/workflows/deploy.yml`).

## Using it in a Tesla

1. Open the car's browser and go to the site URL. Bookmark it, or add it to the home screen if your software has that.
2. Tap **Log in with Spotify** once. The login is remembered, and tokens refresh automatically.
3. Play music on the car's Spotify app (or any device on the same account). The lyrics follow along.

Tips: use **A / A** in the toolbar for text size, and **− / +** to nudge the timing if lyrics run early or late. Everything
else is under the ⚙️ settings button. If the car browser always shows the wrong theme, set **Appearance** to Light or
Dark manually.

## Local development

```bash
npm start        # serves public/ at http://127.0.0.1:5173/
npm test         # unit tests (node:test, no dependencies)
```

Open <http://127.0.0.1:5173/?demo> for the demo. It has original placeholder songs covering word-synced English,
line-synced Chinese with translations, plain lyrics, an instrumental track and a song with no lyrics. To test real
Spotify login locally, register `http://127.0.0.1:5173/` as a redirect URI.

## Limitations

- LRCLIB is community-run. Popular songs are well covered, including many Chinese ones, but some songs have no lyrics,
  or only unsynced ones.
- When a song has no word-level timing, the character fill is an estimate. Use the timing offset if it feels off.
- Spotify reports the playback position only every couple of seconds, so after a seek the lyrics may take a moment to
  settle.

Not affiliated with Tesla, Spotify or LRCLIB.

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
- **Finds lyrics in any language or script.** If the exact lookup misses, it keeps trying:
  - with Spotify's English names (Spotify shows 李荣浩 or "Ronghao Li" depending on the browser's language);
  - by title alone, in Simplified and Traditional (Taiwan and Hong Kong forms);
  - by artist + album.

  The looser searches are accepted only when the song's length matches (±3 s for a title match, ±2 s plus a matching
  album otherwise). Synced lyrics are preferred, and plain lyrics are shown if that's all LRCLIB has.
- **Line sync that stays smooth.** It polls Spotify every second while music plays and interpolates the position
  locally every frame.
- **Tap any line to jump there.** Also play/pause, previous/next, and a seek bar.
- **Adjustments:** text size, line spacing, timing offset (±0.1 s / ±0.5 s steps), left or centered alignment, karaoke on/off,
  show translations, highlight colour (default, album colour, green, gold, pink), background (blurred cover or
  album colour), full screen.
- **Light/dark mode switches automatically.** Auto follows the device's light/dark setting. In browsers that don't
  share it (Tesla's), it switches at local sunrise and sunset instead, using [suncalc](https://github.com/mourner/suncalc)
  and your location. The location is asked for once, rounded to about 10 km, and kept on the device. Without it, light
  runs 07:00–19:00. A ☀️/🌙 button flips the theme by hand (flipping back to what Auto would pick returns to Auto), and
  Settings has Auto / Light / Dark.
- **Two layouts.** *Compact* is for the Tesla browser next to the driving view (and phones). It keeps a small header,
  gives the lyrics the full width, and puts the adjustment buttons in a bar at the bottom, nearest your hand. In Tesla's
  browser it also hides our play/skip buttons, since the car's own media card already has them; other browsers keep
  them in the header. *Full* adds the big cover and playback buttons, for when the browser is full
  screen. Auto picks Full for wide windows and Compact otherwise; Settings → Layout overrides it.
- **English and Simplified Chinese UI.** It picks the language from the browser, and you can change it in Settings.
  Chinese lyrics get proper CJK fonts and `lang` tags, and bilingual LRC files show the translation under each line.
- **Traditional → Simplified Chinese.** Traditional lyrics and song titles are shown in Simplified characters by
  default (toggle in Settings). Conversion uses [opencc-js](https://github.com/nk2028/opencc-js), the JavaScript port
  of OpenCC. It is character-level Taiwan → Mainland (`tw` → `cn`), so wording isn't localised, and anything OpenCC
  leaves unconverted stays Traditional. Japanese and Korean lyrics are never converted. Word timings are kept, and the
  converter (109 KB) is only downloaded when Chinese text appears.
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
| `public/js/clock.js` | Interpolates playback position between polls |
| `public/js/sync.js` | Decides which of Spotify's late, noisy position reports to follow (no jumping back) |
| `public/js/lyrics.js` | LRCLIB lookup with fallbacks, picks Lyricsfile → LRC → plain, caches in localStorage |
| `public/js/lrc.js` | LRC parser (multi-timestamp, `[offset]`, enhanced word tags, translations), Lyricsfile parser |
| `public/js/yaml.js` | Tiny YAML-subset parser for LRCLIB's Lyricsfile |
| `public/js/karaoke.js` | Splits a line into timed segments (exact or estimated) for the character fill |
| `public/js/match.js` | Cleans Spotify titles ("- Remastered 2011", "(feat. X)") and picks the best search result |
| `public/js/i18n.js` | English / 简体中文 strings |
| `public/js/t2s.js` | Traditional → Simplified via the vendored opencc-js (`public/vendor/opencc-js/`) |
| `public/js/s2t.js` | Simplified → Traditional, only for searching LRCLIB (~1 MB, loaded only after a miss) |
| `public/js/storage.js` | localStorage, or an in-memory fallback if the browser blocks it |
| `public/js/sun.js` | Day/night from the sun's position (vendored suncalc), for browsers that don't report dark mode |
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

## Privacy: what is stored and where

The site is only static files on GitHub Pages. There is no server, database or analytics, so nothing about your
Spotify is stored "on the website".

- **Your login stays on your device.** Spotify's access and refresh tokens are kept in that browser's `localStorage`,
  for this site's origin only. Your browser talks directly to `accounts.spotify.com` and `api.spotify.com`. No cookies,
  sessionStorage or IndexedDB are used.
- **Other visitors see nothing of yours.** Anyone else who opens the URL starts logged out and has to sign in with their
  own Spotify account. In Development Mode, Spotify only lets accounts you've added under **User Management** log in.
- **The Client ID is not a secret.** It identifies the app, not you, and it can't be used to reach your account without
  your own Spotify login.
- **Your location never leaves the device.** In browsers that can't report dark mode (like Tesla's), Auto asks for
  your location once to work out sunrise and sunset. It is rounded to about 10 km, stored in `localStorage`, and used
  only for that calculation in the browser. If you decline, it isn't asked again for a month.
- **LRCLIB sees the song name.** To find lyrics, the browser sends the track title, artist, album and duration to
  lrclib.net. Nothing else is sent, and nothing identifies you.
- **Anyone using that device is logged in as you.** The login is remembered in that browser (for example the car).
  Use ⚙️ → **Log out of Spotify** to remove it.

## Tesla browser notes

The app is built for the car's Chromium-based browser:

- **Compatibility:** everything works on Chromium 88, the oldest version reported for Tesla MCU2 browsers. Newer
  CSS (dynamic viewport units, balanced text wrapping, etc.) has fallbacks, and no JavaScript newer than that is used.
  The first-generation MCU1 browser (pre-2018 Model S/X) can't run modern JavaScript; it gets a "browser too old"
  message instead of a blank page.
- **Login:** uses a full-page redirect to Spotify and back, with no pop-ups or embedded frames, so pop-up and
  third-party-cookie restrictions don't matter. The PKCE values that bridge the redirect live in `localStorage`
  rather than `sessionStorage`.
- **Staying logged in:** the refresh token in `localStorage` keeps you logged in across drives. Some owners report the
  car's browser losing site data after a reboot or software update. If that happens, just log in again. If the
  browser refuses storage entirely, the app still works for that visit and says you'll need to log in next time.
- **Performance:** the background blur is pre-rendered on a 64 px canvas instead of a full-screen CSS blur, and the
  animation loop only touches the active line, to stay smooth on older car hardware.
- **Full screen:** Tesla's browser generally doesn't support the Fullscreen API, so that setting only appears where
  it works. Owners use a community workaround: open `youtube.com/redirect?q=<site URL>` and confirm. Tesla doesn't
  support it and has broken it in some updates.
- **Reporting delay:** the car's Spotify tells Spotify's servers about changes a few seconds late, and Spotify
  then counts the position from when it heard. Commands *to* the car (skip or seek from the app) arrive quickly.
  `public/js/sync.js` decides which of Spotify's reports to follow, so the lyrics don't jump back:
  - small differences are judged on the median of recent reports;
  - moving back needs three agreeing reports;
  - a song that follows the previous one is counted from the moment that one ended;
  - seeks and rewinds in the car are followed at once;
  - a tapped line is held until Spotify confirms it.

  A new song still appears only once Spotify reports it. To try it without a car, open `?demo&lag=5`.
- **Dark mode:** Tesla's browser answers the dark-mode query but doesn't follow the car's day/night display, so it
  is detected by its user agent (`Tesla/…`) and Auto switches at sunrise and sunset instead.
- **Restrictions you can't control:** Parental Controls can disable the browser, and whether it can be used while
  driving depends on your software version and region.

## Local development

```bash
npm start        # serves public/ at http://127.0.0.1:5173/
npm test         # unit tests (node:test)
```

Third-party browser code is vendored into `public/vendor/`, so the site needs no build step or CDN. To update it, bump
the version in `package.json`, then run `npm install --ignore-scripts && npm run vendor` and commit the result.

Open <http://127.0.0.1:5173/?demo> for the demo. It has original placeholder songs covering word-synced English,
line-synced Chinese with translations, word-synced Traditional Chinese (shown converted), plain lyrics, an
instrumental track and a song with no lyrics. To test real
Spotify login locally, register `http://127.0.0.1:5173/` as a redirect URI.

## Limitations

- LRCLIB is community-run. Popular songs are well covered, including many Chinese ones, but some songs have no lyrics,
  or only unsynced ones. The fallback searches only accept a match whose length agrees. Very rarely, a different song
  on the same album with the same length could still be picked.
- When a song has no word-level timing, the character fill is an estimate. Use the timing offset if it feels off.
- Spotify reports the playback position only every couple of seconds, so after a seek the lyrics may take a moment to
  settle.

## Third-party code

- [opencc-js](https://github.com/nk2028/opencc-js) 1.4.2: MIT License (code) and Apache License 2.0 (OpenCC dictionary
  data). The license texts are in `public/vendor/opencc-js/`.
- [suncalc](https://github.com/mourner/suncalc) 2.1.4: BSD 2-Clause License, in `public/vendor/suncalc/LICENSE`.

Not affiliated with Tesla, Spotify or LRCLIB.

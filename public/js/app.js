import { CONFIG } from './config.js';
import { AuthError, createAuth, redirectUriFor } from './auth.js';
import { ApiError, AuthRequiredError, RateLimitError, createSpotify } from './spotify.js';
import { createLyricsProvider } from './lyrics.js';
import { createQQLyrics } from './qq.js';
import { PlaybackSync } from './sync.js';
import { findActiveIndex, withIntro } from './lrc.js';
import { guessLang, lineSegments, segmentProgress } from './karaoke.js';
import { analyzeCover, themeFromColor } from './color.js';
import { initTheme } from './theme.js';
import { isTeslaBrowser } from './sun.js';
import { applyI18n, resolveLang, setLang, t } from './i18n.js';
import { LIMITS, loadSettings, saveSettings } from './settings.js';
import { createDemo } from './demo.js';
import { isPersistent, storage } from './storage.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const els = {
  setup: $('screen-setup'),
  login: $('screen-login'),
  player: $('screen-player'),
  cover: $('cover'),
  coverPlaceholder: $('cover-placeholder'),
  title: $('title'),
  artist: $('artist'),
  syncChip: $('sync-chip'),
  simplifiedChip: $('simplified-chip'),
  themeBtn: $('btn-theme'),
  seekbar: $('seekbar'),
  barFill: $('bar-fill'),
  barThumb: $('bar-thumb'),
  tPos: $('t-pos'),
  tDur: $('t-dur'),
  play: $('btn-play'),
  prev: $('btn-prev'),
  next: $('btn-next'),
  lyrics: $('lyrics'),
  status: $('status'),
  statusTitle: $('status-title'),
  statusText: $('status-text'),
  statusRetry: $('status-retry'),
  recenter: $('recenter'),
  conn: $('conn'),
  toast: $('toast'),
  menu: $('menu'),
  syncLabel: $('sync-label'),
  fontRange: $('font-range'),
  fontValue: $('font-value'),
  gapRange: $('gap-range'),
  gapValue: $('gap-value'),
  offsetValue: $('offset-value'),
  artA: $('art-a'),
  artB: $('art-b'),
};

const DEMO = new URLSearchParams(location.search).has('demo');
const KEY_CLIENT_ID = 'spotify:client_id';
const TOOLBAR_OFFSET_STEP = 250;

const settings = loadSettings(storage);
// Decides which of Spotify's (late, noisy) position reports to follow; see sync.js.
const KEY_LATE_STARTS = 'sync:late_starts';
const clock = new PlaybackSync({
  lateStarts: DEMO ? [] : readLateStarts(),
  onLateStart: (list) => !DEMO && storage.setItem(KEY_LATE_STARTS, JSON.stringify(list)),
});

// How late this player's Spotify has reported new songs before (see sync.js).
function readLateStarts() {
  try {
    const list = JSON.parse(storage.getItem(KEY_LATE_STARTS));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
const state = {
  player: null,
  lyricsProvider: null,
  auth: null,
  active: false,
  type: null,
  isPlaying: false,
  track: null,
  lyrics: { status: 'idle', lines: [] }, // what is shown (possibly converted to Simplified)
  lyricsRaw: null, // what LRCLIB returned
  lines: [], // displayed lines (synced: with intro break)
  segs: [], // per line: karaoke segments
  segEls: [], // per line: segment <span>s
  lineEls: [],
  activeIndex: -2,
  activeEl: null,
  gapStep: -1,
  kLine: -1, // line whose karaoke state is currently painted
  kCursor: 0,
  kLastT: 0,
  followPausedUntil: 0,
  pollTimer: 0,
  pollSeq: 0,
  failures: 0,
  lyricsSeq: 0,
  lastSecond: -1,
  running: false,
  artFront: null,
  loginMessage: null,
  accountName: null, // the Spotify account this app is signed in to
};

let theme;
let t2s = null; // lazily loaded Traditional → Simplified converter (js/t2s.js)
let t2sLoading = null;
// Full layout once the window is clearly wide (e.g. the car browser in full screen,
// ~16:10); anything narrower (the browser beside Tesla's driving view, phones) is compact.
// (Declared up here: boot() below runs before the rest of the module is evaluated.)
const WIDE_WINDOW = '(min-aspect-ratio: 29/20) and (min-width: 1000px)';
let wideWindow = null;
let toastTimer = 0;

// ---------- boot ----------

boot()
  .catch((e) => {
    console.error(e);
    showLogin(t('err.generic', { msg: e.message }));
  })
  .finally(() => root.classList.remove('booting'));

async function boot() {
  theme = initTheme({ onChange: updateThemeChrome, storage });
  setLang(resolveLang(settings.lang, navigator.languages || [navigator.language]));
  applyI18n();
  applySettings();
  bindUi();

  if (DEMO) {
    // ?demo&lag=5 reports every change 5 s late (and behind), like a car's Spotify.
    const lagSec = Number(new URLSearchParams(location.search).get('lag'));
    const demo = createDemo({ reportLagMs: Number.isFinite(lagSec) && lagSec > 0 ? lagSec * 1000 : 0 });
    state.player = demo.player;
    state.lyricsProvider = demo.lyrics;
    document.body.classList.add('is-demo');
    $('menu-logout').hidden = true;
    $('menu-exit-demo').hidden = false;
    showScreen('player');
    renderAllText();
    startPolling();
    return;
  }

  const redirectUri = redirectUriFor(location);
  const clientId = (CONFIG.spotifyClientId || storage.getItem(KEY_CLIENT_ID) || '').trim();
  const clientIdEditable = !CONFIG.spotifyClientId;
  $('change-client').hidden = !clientIdEditable;
  $('menu-client').hidden = !clientIdEditable;

  if (!clientId) {
    $('redirect-uri').textContent = redirectUri;
    showScreen('setup');
    return;
  }

  state.auth = createAuth({ clientId, redirectUri, scopes: CONFIG.scopes, storage });
  try {
    if (await state.auth.handleRedirect(location.href)) history.replaceState(null, '', redirectUri);
  } catch (e) {
    history.replaceState(null, '', redirectUri);
    showLogin(authMessage(e));
    return;
  }

  if (!state.auth.isLoggedIn()) {
    showLogin();
    return;
  }

  state.player = createSpotify({ auth: state.auth });
  const qq = CONFIG.lyricsRelay ? createQQLyrics({ relay: CONFIG.lyricsRelay }) : null;
  state.lyricsProvider = createLyricsProvider({
    base: CONFIG.lrclibBase,
    client: CONFIG.lrclibClient,
    storage,
    backup: qq ? (track, opts) => qq.find(track, opts) : null,
  });
  showScreen('player');
  renderAllText();
  startPolling();
  if (!isPersistent) toast(t('storage.notSaved'));
  // Shown on the "Nothing playing" screen: in a Tesla, the car's Spotify may be signed in
  // to a different account than this app, and then nothing ever shows up here.
  state.player
    .profile()
    .then((name) => {
      state.accountName = name;
      renderAccount();
      renderStatus();
    })
    .catch(() => {});
}

function authMessage(e) {
  if (e instanceof AuthError) {
    if (e.code === 'access_denied') return t('err.loginCancelled');
    if (e.code === 'state_mismatch') return t('err.loginState');
    return t('err.loginFailed', { msg: e.code || e.message });
  }
  return t('err.generic', { msg: e.message });
}

function showScreen(name) {
  els.setup.hidden = name !== 'setup';
  els.login.hidden = name !== 'login';
  els.player.hidden = name !== 'player';
}

function showLogin(message) {
  stopPolling();
  state.loginMessage = message || null;
  const err = $('login-error');
  err.hidden = !message;
  err.textContent = message || '';
  showScreen('login');
}

// ---------- settings ----------

function applyLayout() {
  if (!wideWindow && globalThis.matchMedia) {
    wideWindow = matchMedia(WIDE_WINDOW);
    wideWindow.addEventListener?.('change', applyLayout);
  }
  const layout = settings.layout === 'auto' ? (wideWindow?.matches ? 'full' : 'compact') : settings.layout;
  if (root.dataset.layout === layout) return;
  root.dataset.layout = layout;
  requestAnimationFrame(() => scrollToActive(false));
}

function applySettings() {
  // In Tesla's browser the car's own media card has play/skip, so Compact hides ours.
  if (isTeslaBrowser()) root.dataset.browser = 'tesla';
  applyLayout();
  root.style.setProperty('--font-scale', String(settings.fontScale));
  root.style.setProperty('--line-gap', String(settings.lineGap));
  root.dataset.align = settings.align;
  root.dataset.hl = settings.highlight;
  root.dataset.bg = settings.background;
  root.dataset.karaoke = settings.karaoke ? 'on' : 'off';
  root.dataset.translation = settings.translation ? 'on' : 'off';
  renderSyncLabel();
  syncPanel();
  // Size and alignment change line positions, so re-center the active line.
  requestAnimationFrame(() => scrollToActive(false));
}

function updateSetting(key, value) {
  settings[key] = value;
  saveSettings(settings, storage);
  if (key === 'simplified') refreshLyricsPresentation();
  if (key === 'lang') {
    setLang(resolveLang(value, navigator.languages || [navigator.language]));
    applyI18n();
    renderAllText();
  }
  applySettings();
}

function syncPanel() {
  els.fontRange.value = String(Math.round(settings.fontScale * 100));
  els.fontValue.textContent = `${Math.round(settings.fontScale * 100)}%`;
  if (els.gapRange) els.gapRange.value = String(Math.round(settings.lineGap * 100));
  if (els.gapValue) els.gapValue.textContent = `${Math.round(settings.lineGap * 100)}%`;
  els.offsetValue.textContent = formatOffset(settings.offsetMs, true);
  for (const group of document.querySelectorAll('[data-setting]')) {
    const key = group.dataset.setting;
    const current = key === 'theme' ? theme?.pref : settings[key];
    for (const b of group.querySelectorAll('[data-value]')) b.setAttribute('aria-pressed', String(b.dataset.value === current));
  }
  for (const input of document.querySelectorAll('[data-setting-bool]')) input.checked = Boolean(settings[input.dataset.settingBool]);
}

/** Toolbar shows a compact signed value; the tooltip spells it out. */
function renderSyncLabel() {
  const ms = settings.offsetMs;
  els.syncLabel.textContent = ms ? formatOffset(ms, true) : t('sync.inSync');
  $('sync-reset').title = ms ? `${formatOffset(ms)} · ${t('sync.resetTitle')}` : t('sync.resetTitle');
}

function formatOffset(ms, signed = false) {
  if (!ms) return signed ? '0.0s' : t('sync.inSync');
  const s = (Math.abs(ms) / 1000).toFixed(2).replace(/0$/, '');
  if (signed) return `${ms > 0 ? '+' : '−'}${s}s`;
  return ms > 0 ? t('sync.earlier', { s }) : t('sync.later', { s });
}

function changeFont(delta, { quiet = false } = {}) {
  const next = Math.round(Math.min(LIMITS.fontScale[1], Math.max(LIMITS.fontScale[0], settings.fontScale + delta)) * 100) / 100;
  updateSetting('fontScale', next);
  if (!quiet) toast(t('toast.textSize', { n: Math.round(next * 100) }));
}

function changeOffset(delta) {
  updateSetting('offsetMs', Math.max(LIMITS.offsetMs[0], Math.min(LIMITS.offsetMs[1], settings.offsetMs + delta)));
}

// ---------- polling ----------

function startPolling() {
  if (state.running) return;
  state.running = true;
  poll();
  requestAnimationFrame(frame);
}

function stopPolling() {
  state.running = false;
  state.pollSeq++;
  clearTimeout(state.pollTimer);
}

async function poll() {
  if (!state.running) return;
  clearTimeout(state.pollTimer);
  const seq = ++state.pollSeq;
  let delay;
  try {
    const pb = await state.player.nowPlaying();
    if (seq !== state.pollSeq) return; // superseded by a newer poll
    state.failures = 0;
    setConnection(true);
    applyPlayback(pb);
    delay = nextDelay();
  } catch (e) {
    if (seq !== state.pollSeq) return;
    if (e instanceof AuthRequiredError) {
      showLogin(t('err.sessionEnded'));
      return;
    }
    console.warn('Poll failed', e);
    state.failures++;
    setConnection(false);
    delay = e instanceof RateLimitError ? e.retryAfterSec * 1000 : Math.min(30_000, 2000 * 2 ** (state.failures - 1));
  }
  state.pollTimer = setTimeout(poll, delay);
}

function nextDelay() {
  const { pollMs } = CONFIG;
  if (document.hidden) return pollMs.hidden;
  if (!state.track) return pollMs.idle;
  if (!state.isPlaying) return pollMs.paused;
  // Poll just after the song should end so the next song's lyrics show up promptly.
  return Math.max(500, Math.min(pollMs.playing, clock.remaining() + 400));
}

function pollSoon(ms = 500) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(poll, ms);
}

function setConnection(ok) {
  // Only complain after a couple of failures; a single blip isn't worth a banner.
  els.conn.hidden = ok || state.failures < 2;
}

function applyPlayback(pb) {
  state.active = pb.active;
  state.type = pb.type;
  state.isPlaying = pb.isPlaying;

  const track = pb.track;
  if ((track?.id ?? null) !== (state.track?.id ?? null)) setTrack(track);

  if (track) {
    clock.report({
      trackId: track.id,
      progressMs: pb.progressMs,
      sampledAt: pb.sampledAt,
      uncertaintyMs: pb.uncertaintyMs,
      isPlaying: pb.isPlaying,
      durationMs: track.durationMs,
    });
  } else {
    clock.stop();
  }
  renderPlayState();
  renderStatus();
}

// ---------- track, artwork, lyrics ----------

function setTrack(track) {
  state.track = track;
  state.lastSecond = -1;
  renderTrackText();
  els.tDur.textContent = formatTime(track?.durationMs ?? 0);
  // The animation loop only runs the bar while something plays, so reset it here.
  els.tPos.textContent = formatTime(0);
  els.barFill.style.transform = 'scaleX(0)';
  els.barThumb.style.transform = 'translateX(0%)';
  els.seekbar.setAttribute('aria-valuenow', '0');

  if (track?.image) {
    els.cover.src = track.image;
    els.cover.alt = track.album || '';
    els.cover.hidden = false;
    els.coverPlaceholder.hidden = true;
  } else {
    els.cover.removeAttribute('src');
    els.cover.hidden = true;
    els.coverPlaceholder.hidden = false;
  }
  updateArtwork(track);
  loadLyrics(track);
}

function renderTrackText() {
  const track = state.track;
  const convert = track && wantsSimplified(trackTexts(track));
  if (convert && !t2s) loadT2S().then(() => state.track === track && renderTrackText());
  const show = (text) => (convert && t2s ? t2s.toSimplified(text) : text);
  const name = track ? show(track.name) : '';
  const artists = track ? track.artists.map(show) : [];

  els.title.textContent = track ? name : state.type === 'ad' ? t('player.ad') : t('player.notPlaying');
  els.artist.textContent = artists.join(', ');
  const lang = track ? guessLang([track.name, ...track.artists]) : '';
  for (const el of [els.title, els.artist]) {
    if (lang) el.lang = lang;
    else el.removeAttribute('lang');
  }
  document.title = track ? `${name} · ${artists[0] ?? ''}` : t('app.title');
}

// ---------- Traditional → Simplified Chinese ----------

function loadT2S() {
  t2sLoading ||= import('./t2s.js')
    .then((m) => (t2s = m))
    .catch((e) => {
      console.warn('Chinese converter failed to load', e);
      t2sLoading = null;
      return null;
    });
  return t2sLoading;
}

function trackTexts(track) {
  return track ? [track.name, ...track.artists, track.album || ''] : [];
}

/**
 * Convert only Chinese: guessLang says 'zh-CN' for Han text without kana or hangul.
 * Japanese and Korean also use Han characters and must not be converted, so the
 * decision looks at the title, artists and lyrics together.
 */
function wantsSimplified(texts) {
  return settings.simplified && guessLang(texts) === 'zh-CN';
}

/** What to display for a lyrics result: converted to Simplified when that applies. */
async function presentLyrics(raw, track) {
  const lines = raw?.lines || [];
  const texts = lines.map((l) => `${l.text} ${l.translation || ''}`);
  if (!lines.length || !wantsSimplified([...trackTexts(track), ...texts])) return raw;
  const mod = await loadT2S();
  if (!mod) return raw;
  const converted = mod.simplifyLines(lines);
  const changed = converted.some((l, i) => l.text !== lines[i].text || l.translation !== lines[i].translation);
  return changed ? { ...raw, lines: converted, simplified: true } : raw;
}

/** Re-apply (or undo) the conversion after the setting changes. */
async function refreshLyricsPresentation() {
  renderTrackText();
  const track = state.track;
  const raw = state.lyricsRaw;
  if (!raw || !track) return;
  const shown = await presentLyrics(raw, track);
  if (state.track === track && state.lyricsRaw === raw) setLyrics(shown);
}

async function updateArtwork(track) {
  const style = root.style;
  const { rgb, backdrop } = await analyzeCover(track ? track.imageMedium || track.image : null);
  if (track !== state.track) return; // track changed while the image loaded
  setBackdropImage(backdrop);
  const vars = ['--cover-dark', '--cover-dark-deep', '--cover-light', '--cover-light-deep', '--cover-accent-dark', '--cover-accent-light'];
  if (!rgb) {
    for (const k of vars) style.removeProperty(k);
  } else {
    const c = themeFromColor(rgb);
    const values = [c.dark, c.darkDeep, c.light, c.lightDeep, c.accentDark, c.accentLight];
    vars.forEach((k, i) => (values[i] ? style.setProperty(k, values[i]) : style.removeProperty(k)));
  }
  updateThemeChrome();
}

/** Cross-fade the (pre-blurred) cover behind everything. */
function setBackdropImage(dataUrl) {
  const next = state.artFront === els.artA ? els.artB : els.artA;
  if (dataUrl) {
    next.style.backgroundImage = `url("${dataUrl}")`;
    next.classList.add('show');
  }
  state.artFront?.classList.remove('show');
  state.artFront = dataUrl ? next : null;
}

function updateThemeChrome() {
  // Match the browser UI colour to the page background.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#121212');
  // The toggle shows the current mode; its label says what tapping it does.
  const dark = root.dataset.theme === 'dark';
  const label = t(dark ? 'aria.toLight' : 'aria.toDark');
  els.themeBtn?.querySelector('use')?.setAttribute('href', dark ? '#i-moon' : '#i-sun');
  els.themeBtn?.setAttribute('aria-label', label);
  if (els.themeBtn) els.themeBtn.title = label;
  syncPanel();
}

async function loadLyrics(track) {
  const seq = ++state.lyricsSeq;
  if (!track || track.isEpisode) {
    state.lyricsRaw = null;
    return setLyrics({ status: track ? 'episode' : 'idle', lines: [] });
  }
  state.lyricsRaw = null;
  setLyrics({ status: 'loading', lines: [] });
  try {
    const result = await state.lyricsProvider.get(track, {
      // Spotify localises names by browser language; on a miss, retry with English names.
      alternates: state.player.englishNames ? () => state.player.englishNames(track.id) : undefined,
    });
    const shown = await presentLyrics(result, track);
    if (seq !== state.lyricsSeq) return;
    state.lyricsRaw = result;
    setLyrics(shown);
    // Lyrics from a different-length version of the song: say so, since their timing is
    // baked in and no amount of syncing with Spotify can fix it.
    if (result.approximate) toast(t('toast.approxTiming'), 7000);
    // Lyrics can reveal a Japanese song with a kanji-only title; re-check the title.
    if (state.lyricsRaw.lines?.length) renderTrackText();
  } catch (e) {
    console.warn('Lyrics lookup failed', e);
    if (seq === state.lyricsSeq) setLyrics({ status: 'error', lines: [] });
  }
}

function setLyrics(result) {
  state.lyrics = result;
  state.lines = result.status === 'synced' ? withIntro(result.lines) : result.lines;
  state.activeIndex = -2;
  state.activeEl = null;
  state.gapStep = -1;
  state.kLine = -1;
  state.followPausedUntil = 0;
  els.recenter.hidden = true;
  renderLyrics();
  renderStatus();
  renderChip();
  els.lyrics.scrollTop = 0;
}

function renderLyrics() {
  const synced = state.lyrics.status === 'synced';
  const plain = state.lyrics.status === 'plain';
  els.lyrics.classList.toggle('is-synced', synced);
  els.lyrics.classList.toggle('is-plain', plain);
  const lang = guessLang(state.lines.map((l) => l.text));
  if (lang) els.lyrics.lang = lang;
  else els.lyrics.removeAttribute('lang');

  const frag = document.createDocumentFragment();
  state.segs = [];
  state.segEls = [];
  state.lineEls = state.lines.map((line, i) => {
    const div = document.createElement('div');
    div.className = 'line';
    if (line.text === '') {
      if (synced) {
        div.dataset.i = String(i);
        div.classList.add('gap');
        div.setAttribute('aria-label', t('status.instrumental'));
        div.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      } else {
        div.classList.add('spacer');
      }
    } else if (synced) {
      div.dataset.i = String(i);
      const segs = lineSegments(line, state.lines[i + 1]?.time);
      const main = document.createElement('span');
      main.className = 'main';
      state.segEls[i] = segs.map((seg) => {
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = seg.text;
        main.append(span);
        return span;
      });
      state.segs[i] = segs;
      div.append(main);
      if (line.translation) {
        const tr = document.createElement('span');
        tr.className = 'tr';
        tr.textContent = line.translation;
        const trLang = guessLang([line.translation]);
        tr.lang = trLang || 'en';
        div.append(tr);
      }
    } else {
      div.textContent = line.text;
    }
    frag.append(div);
    return div;
  });
  els.lyrics.replaceChildren(frag);
}

function renderStatus() {
  let title = '';
  let text = '';
  let retry = false;
  const s = state.lyrics.status;

  if (!state.track) {
    if (state.type === 'ad') {
      title = t('player.ad');
      text = t('status.adText');
    } else {
      title = t('status.nothing');
      text = t('status.nothingText');
      if (state.accountName) text += ` ${t('status.nothingAccount', { name: state.accountName })}`;
    }
  } else if (s === 'episode') {
    title = t('status.podcast');
    text = t('status.podcastText');
  } else if (s === 'loading') {
    title = t('status.loading');
  } else if (s === 'none') {
    title = t('status.none');
    text = t('status.noneText');
  } else if (s === 'instrumental') {
    title = t('status.instrumental');
    text = t('status.instrumentalText');
  } else if (s === 'error') {
    title = t('status.error');
    text = t('status.errorText');
    retry = true;
  }

  els.status.hidden = !title;
  els.status.classList.toggle('loading', s === 'loading' && Boolean(state.track));
  els.statusTitle.textContent = title;
  els.statusText.textContent = text;
  els.statusText.hidden = !text;
  els.statusRetry.hidden = !retry;
}

function renderChip() {
  const s = state.lyrics.status;
  const key = s === 'synced' ? (state.lyrics.wordSynced ? 'chip.word' : 'chip.line') : s === 'plain' ? 'chip.plain' : null;
  els.syncChip.hidden = !key;
  if (key) els.syncChip.textContent = t(key);
  if (els.simplifiedChip) els.simplifiedChip.hidden = !state.lyrics.simplified;
}

function renderPlayState() {
  const playing = state.isPlaying;
  els.play.setAttribute('aria-label', t(playing ? 'aria.pause' : 'aria.play'));
  els.play.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  document.body.classList.toggle('is-paused', !playing);
}

/** Re-render every piece of dynamic text (after a language change). */
function renderAllText() {
  renderTrackText();
  renderStatus();
  renderChip();
  renderPlayState();
  renderSyncLabel();
  updateThemeChrome();
  if (state.loginMessage) $('login-error').textContent = state.loginMessage;
  for (const el of els.lyrics.querySelectorAll('.gap')) el.setAttribute('aria-label', t('status.instrumental'));
}

// ---------- animation loop ----------

function frame() {
  if (!state.running) return;
  requestAnimationFrame(frame);
  if (!state.track) return;

  const pos = clock.position();
  const dur = state.track.durationMs || 1;
  const frac = Math.min(1, pos / dur);
  els.barFill.style.transform = `scaleX(${frac})`;
  els.barThumb.style.transform = `translateX(${frac * 100}%)`;
  const sec = Math.floor(pos / 1000);
  if (sec !== state.lastSecond) {
    state.lastSecond = sec;
    els.tPos.textContent = formatTime(pos);
    els.seekbar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  }

  if (state.lyrics.status !== 'synced') return;
  if (state.followPausedUntil && performance.now() >= state.followPausedUntil) resumeFollow();

  const tNow = pos + settings.offsetMs;
  const idx = findActiveIndex(state.lines, tNow);
  if (idx !== state.activeIndex) setActive(idx);
  if (idx < 0) return;

  const line = state.lines[idx];
  if (line.text === '') updateGap(idx, tNow, dur);
  else if (settings.karaoke) updateKaraoke(idx, tNow);
}

/** Paint the character-by-character fill of the active line. */
function updateKaraoke(idx, tNow) {
  const segs = state.segs[idx];
  const spans = state.segEls[idx];
  if (!segs || !spans) return;
  if (state.kLine !== idx || tNow < state.kLastT - 30) {
    // New line, or time went backwards (seek / clock correction): start over.
    for (const s of spans) {
      s.classList.remove('done');
      s.style.removeProperty('--p');
    }
    state.kLine = idx;
    state.kCursor = 0;
  }
  state.kLastT = tNow;
  while (state.kCursor < segs.length && tNow >= segs[state.kCursor].end) {
    const span = spans[state.kCursor];
    span.classList.add('done');
    span.style.removeProperty('--p');
    state.kCursor++;
  }
  const c = state.kCursor;
  if (c < segs.length && tNow > segs[c].start) {
    spans[c].style.setProperty('--p', segmentProgress(segs[c], tNow).toFixed(3));
  }
}

/** Fill the "• • •" dots during an instrumental break. */
function updateGap(idx, tNow, dur) {
  const line = state.lines[idx];
  const end = state.lines[idx + 1]?.time ?? dur;
  const step = Math.min(3, Math.floor(((tNow - line.time) / Math.max(1, end - line.time)) * 3) + 1);
  if (step !== state.gapStep && state.activeEl) {
    state.gapStep = step;
    state.activeEl.dataset.step = String(step);
  }
}

function setActive(idx) {
  state.activeIndex = idx;
  state.gapStep = -1;
  state.lineEls.forEach((el, i) => {
    const d = Math.abs(i - idx);
    el.classList.toggle('active', i === idx);
    el.classList.toggle('past', i < idx);
    if (d >= 1 && d <= 3) el.dataset.d = String(d);
    else delete el.dataset.d;
    if (i !== idx) delete el.dataset.step;
  });
  state.activeEl = state.lineEls[idx] || null;
  if (!state.followPausedUntil) scrollToActive(true);
}

function scrollToActive(smooth) {
  if (state.lyrics.status !== 'synced' || state.followPausedUntil) return;
  const box = els.lyrics;
  const el = state.activeEl;
  const top = el ? el.offsetTop + el.offsetHeight / 2 - box.clientHeight * 0.42 : 0;
  box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

function pauseFollow() {
  if (state.lyrics.status !== 'synced') return;
  state.followPausedUntil = performance.now() + 6000;
  els.recenter.hidden = false;
}

function resumeFollow() {
  state.followPausedUntil = 0;
  els.recenter.hidden = true;
  scrollToActive(true);
}

// ---------- controls ----------

async function control(action, optimistic, confirmAfterMs = 600) {
  // A poll already in flight would report the state from before this action and
  // briefly undo the optimistic update, so discard its result.
  state.pollSeq++;
  optimistic?.();
  renderPlayState();
  try {
    await action();
  } catch (e) {
    reportControlError(e);
  }
  pollSoon(confirmAfterMs);
}

function reportControlError(e) {
  console.warn('Control failed', e);
  if (e instanceof AuthRequiredError) return showLogin(t('err.sessionEnded'));
  if (e instanceof RateLimitError) return toast(t('toast.busy'));
  if (e instanceof ApiError && e.status === 403) return toast(t('toast.premium'));
  if (e instanceof ApiError && e.status === 404) return toast(t('toast.noDevice'));
  toast(t('toast.unreachable'));
}

function togglePlay() {
  if (!state.player) return;
  if (state.isPlaying) {
    control(() => state.player.pause(), () => {
      state.isPlaying = false;
      clock.setPlaying(false);
    });
  } else {
    control(() => state.player.play(), () => {
      state.isPlaying = true;
      clock.setPlaying(true);
    });
  }
}

function seekTo(ms) {
  if (!state.track) return;
  const target = Math.max(0, Math.min(ms, state.track.durationMs - 500));
  state.followPausedUntil = 0;
  els.recenter.hidden = true;
  // The tapped line is shown at once and held until Spotify confirms it (see sync.js).
  let pending;
  control(
    () =>
      state.player.seek(target).catch((e) => {
        clock.cancelSeek(pending); // only this seek: a newer tap keeps its own hold
        throw e;
      }),
    () => (pending = clock.seek(target)),
    900,
  );
}

function skip(dir) {
  if (!state.player) return;
  // Spotify hears about a skip from this page at once, unlike one on the car's controls.
  // (The demo's fake player is the "car", so there it counts as a car skip.)
  if (!DEMO) clock.expectChange();
  control(() => (dir > 0 ? state.player.next() : state.player.previous()), null, 400);
}

function toast(message, durationMs = 2600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  els.toast.classList.remove('show');
  void els.toast.offsetWidth; // restart the transition
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => (els.toast.hidden = true), 300);
  }, durationMs);
}

function bindUi() {
  els.play.addEventListener('click', togglePlay);
  els.themeBtn?.addEventListener('click', () => theme.toggle());
  els.prev.addEventListener('click', () => skip(-1));
  els.next.addEventListener('click', () => skip(1));
  $('font-down').addEventListener('click', () => changeFont(-0.1));
  $('font-up').addEventListener('click', () => changeFont(0.1));
  $('sync-earlier').addEventListener('click', () => changeOffset(TOOLBAR_OFFSET_STEP));
  $('sync-later').addEventListener('click', () => changeOffset(-TOOLBAR_OFFSET_STEP));
  $('sync-reset').addEventListener('click', () => updateSetting('offsetMs', 0));
  els.statusRetry.addEventListener('click', () => {
    if (!state.track) return;
    state.lyricsProvider.forget?.(state.track.id);
    loadLyrics(state.track);
  });
  els.recenter.addEventListener('click', resumeFollow);

  // Tap a line to jump there.
  els.lyrics.addEventListener('click', (e) => {
    const el = e.target.closest('.line[data-i]');
    if (!el || state.lyrics.status !== 'synced') return;
    const line = state.lines[Number(el.dataset.i)];
    if (line) seekTo(line.time - settings.offsetMs + 10);
  });
  // Let the user scroll freely; auto-follow resumes after a few seconds.
  for (const type of ['wheel', 'touchmove']) els.lyrics.addEventListener(type, pauseFollow, { passive: true });

  // Seek bar.
  els.seekbar.addEventListener('click', (e) => {
    if (!state.track) return;
    const r = els.seekbar.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * state.track.durationMs);
  });
  els.seekbar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      seekTo(clock.position() + (e.key === 'ArrowRight' ? 5000 : -5000));
    }
  });

  // Full screen (where the browser allows it), toggled from the settings sheet.
  const fs = $('fullscreen-toggle');
  if (document.fullscreenEnabled) {
    $('fullscreen-row').hidden = false;
    fs.addEventListener('change', () => {
      if (!fs.checked) document.exitFullscreen?.().catch(() => {});
      else root.requestFullscreen().catch(() => {
        fs.checked = false;
        toast(t('toast.noFullscreen'));
      });
    });
    document.addEventListener('fullscreenchange', () => (fs.checked = Boolean(document.fullscreenElement)));
  }

  // Settings sheet.
  $('btn-menu').addEventListener('click', () => {
    syncPanel();
    renderAccount();
    els.menu.showModal();
  });
  $('check-connection')?.addEventListener('click', checkConnection);
  els.menu.addEventListener('click', (e) => {
    if (e.target === els.menu) els.menu.close(); // tap outside the sheet
  });
  els.fontRange.addEventListener('input', () => updateSetting('fontScale', Number(els.fontRange.value) / 100));
  els.gapRange?.addEventListener('input', () => updateSetting('lineGap', Number(els.gapRange.value) / 100));
  for (const b of document.querySelectorAll('[data-gap-step]')) {
    b.addEventListener('click', () => {
      const next = Math.round((settings.lineGap + Number(b.dataset.gapStep)) * 100) / 100;
      updateSetting('lineGap', Math.min(LIMITS.lineGap[1], Math.max(LIMITS.lineGap[0], next)));
    });
  }
  for (const b of document.querySelectorAll('[data-font-step]')) {
    b.addEventListener('click', () => changeFont(Number(b.dataset.fontStep), { quiet: true }));
  }
  for (const b of document.querySelectorAll('[data-offset-step]')) {
    b.addEventListener('click', () => changeOffset(Number(b.dataset.offsetStep)));
  }
  $('offset-reset').addEventListener('click', () => updateSetting('offsetMs', 0));
  for (const group of document.querySelectorAll('[data-setting]')) {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[data-value]');
      if (!b) return;
      const key = group.dataset.setting;
      if (key === 'theme') {
        theme.set(b.dataset.value);
        syncPanel();
      } else {
        updateSetting(key, b.dataset.value);
      }
    });
  }
  for (const input of document.querySelectorAll('[data-setting-bool]')) {
    input.addEventListener('change', () => updateSetting(input.dataset.settingBool, input.checked));
  }
  $('menu-logout').addEventListener('click', () => {
    state.auth?.logout();
    location.reload();
  });
  $('menu-exit-demo').addEventListener('click', () => location.assign(location.pathname));
  const changeClient = () => {
    storage.removeItem(KEY_CLIENT_ID);
    state.auth?.logout();
    location.assign(location.pathname);
  };
  $('menu-client').addEventListener('click', changeClient);
  $('change-client').addEventListener('click', changeClient);

  // Login + setup.
  $('login').addEventListener('click', () => state.auth?.login().catch((e) => showLogin(authMessage(e))));
  $('copy-redirect').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('redirect-uri').textContent);
      toast(t('toast.copied'));
    } catch {
      getSelection().selectAllChildren($('redirect-uri'));
    }
  });
  $('client-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('client-id').value.trim();
    const err = $('client-error');
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      err.textContent = t('setup.invalid');
      err.hidden = false;
      return;
    }
    storage.setItem(KEY_CLIENT_ID, id);
    location.assign(location.pathname);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.running) pollSoon(0);
  });
  window.addEventListener('resize', () => scrollToActive(false));

  // Keyboard shortcuts (handy on a laptop).
  document.addEventListener('keydown', (e) => {
    if (els.player.hidden || els.menu.open || e.target.closest('input, textarea')) return;
    const onSlider = e.target.closest('[role="slider"]');
    if (e.key === ' ') {
      if (e.target.closest('button, [role="slider"]')) return; // the focused control handles Space
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowRight' && !onSlider) skip(1);
    else if (e.key === 'ArrowLeft' && !onSlider) skip(-1);
    else if (e.key === '+' || e.key === '=') changeFont(0.1);
    else if (e.key === '-') changeFont(-0.1);
    else if (e.key === ']') changeOffset(100);
    else if (e.key === '[') changeOffset(-100);
  });
}

function renderAccount() {
  const el = $('account-name');
  if (el) el.textContent = state.accountName || '—';
}

/** Settings → "Check Spotify connection": show what Spotify itself reports for this account. */
async function checkConnection() {
  const box = $('connection-report');
  if (!box || !state.player?.connectionInfo) return;
  const para = (text, cls) => {
    const p = document.createElement('p');
    p.textContent = text; // names come from Spotify: always plain text, never HTML
    if (cls) p.className = cls;
    return p;
  };
  box.hidden = false;
  box.replaceChildren(para(t('conn.checking')));
  try {
    const info = await state.player.connectionInfo();
    if (info.account) {
      state.accountName = info.account;
      renderAccount();
    }
    const nodes = [];
    if (info.account) nodes.push(para(t('conn.account', { name: info.account })));
    nodes.push(
      para(
        info.nowPlaying
          ? `${t('conn.nowPlaying', { track: info.nowPlaying })}${info.playingOn ? ` ${t('conn.onDevice', { device: info.playingOn })}` : ''}`
          : t('conn.nothingPlaying'),
      ),
    );
    nodes.push(para(t('conn.devices')));
    const list = document.createElement('ul');
    const item = (text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    };
    if (!info.devices.length) list.append(item(t('conn.noDevices')));
    for (const d of info.devices) {
      const tags = [d.type, d.active && t('conn.active'), d.restricted && t('conn.restricted'), d.privateSession && t('conn.private')];
      list.append(item(`${d.name} (${tags.filter(Boolean).join(' · ')})`));
    }
    nodes.push(list);
    if (info.error) nodes.push(para(t('conn.error', { msg: info.error.message })));
    nodes.push(para(t('conn.carHint'), 'note'));
    box.replaceChildren(...nodes);
  } catch (e) {
    if (e instanceof AuthRequiredError) return showLogin(t('err.sessionEnded'));
    box.replaceChildren(para(t('conn.error', { msg: e.message })));
  }
}

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

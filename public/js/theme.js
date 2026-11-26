// Light/dark theme. "auto" (the default) follows the device's light/dark setting via
// prefers-color-scheme and switches live when it changes. Where the browser can't report
// that setting (Tesla's browser), "auto" follows the sun instead: light after local
// sunrise, dark after sunset (see sun.js). Light/Dark can also be forced.
// index.html applies a first guess inline before first paint to avoid a flash.
import { createSunClock, systemThemeKnown } from './sun.js';

const KEY = 'settings:theme';
export const THEME_PREFS = ['auto', 'light', 'dark'];

export function resolveTheme(pref, autoIsLight) {
  if (pref === 'light' || pref === 'dark') return pref;
  return autoIsLight ? 'light' : 'dark';
}

export function getThemePref(storage = globalThis.localStorage) {
  try {
    const v = storage.getItem(KEY);
    return THEME_PREFS.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Start applying the theme to <html data-theme>. Calls onChange(theme, pref) whenever
 * it is (re)applied. Returns an object to read and change the user's preference.
 */
export function initTheme({
  onChange = () => {},
  root = document.documentElement,
  storage = globalThis.localStorage,
  matchMedia = globalThis.matchMedia,
  userAgent = globalThis.navigator?.userAgent || '',
  sunClock,
} = {}) {
  const mql = matchMedia?.('(prefers-color-scheme: light)');
  const systemKnown = systemThemeKnown({ matchMedia, userAgent });
  const sun = systemKnown ? null : sunClock || createSunClock({ storage, onChange: () => apply() });
  let pref = getThemePref(storage);

  /** What "auto" picks right now: the device setting, or the sun where that's unknown. */
  const autoTheme = () => (sun ? (sun.isDay() ? 'light' : 'dark') : mql?.matches ? 'light' : 'dark');

  function apply() {
    const theme = resolveTheme(pref, autoTheme() === 'light');
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
    root.dataset.themePref = pref;
    root.dataset.themeSource = sun ? 'sun' : 'system';
    // Only watch the sun (and ask for the location) while it actually decides the theme.
    if (sun) {
      if (pref === 'auto') sun.start();
      else sun.stop();
    }
    onChange(theme, pref);
  }

  mql?.addEventListener?.('change', apply);
  apply();

  return {
    get pref() {
      return pref;
    },
    get theme() {
      return root.dataset.theme;
    },
    /** 'system' or 'sun': what "auto" follows in this browser. */
    get source() {
      return sun ? 'sun' : 'system';
    },
    /** What "auto" would pick right now. */
    get system() {
      return autoTheme();
    },
    /** Flip light ↔ dark. Landing on what "auto" would pick goes back to "auto". */
    toggle() {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      this.set(next === this.system ? 'auto' : next);
    },
    set(next) {
      pref = THEME_PREFS.includes(next) ? next : 'auto';
      try {
        storage.setItem(KEY, pref);
      } catch {
        /* ignore */
      }
      apply();
    },
  };
}

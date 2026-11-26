// Light/dark theme. "auto" (the default) follows the system setting via
// prefers-color-scheme and switches live when it changes. Light/Dark can be forced
// from the menu — useful on browsers (like some car browsers) that don't report it.
// index.html applies the theme inline before first paint to avoid a flash.

const KEY = 'settings:theme';
export const THEME_PREFS = ['auto', 'light', 'dark'];

export function resolveTheme(pref, systemPrefersLight) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersLight ? 'light' : 'dark';
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
 * Start applying the theme to <html data-theme>. Calls onChange(theme) whenever the
 * resolved theme changes. Returns a setter for the user's preference.
 */
export function initTheme({ onChange = () => {}, root = document.documentElement } = {}) {
  const mql = globalThis.matchMedia?.('(prefers-color-scheme: light)');
  let pref = getThemePref();

  function apply() {
    const theme = resolveTheme(pref, Boolean(mql?.matches));
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
    root.dataset.themePref = pref;
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
    set(next) {
      pref = THEME_PREFS.includes(next) ? next : 'auto';
      try {
        localStorage.setItem(KEY, pref);
      } catch {
        /* ignore */
      }
      apply();
    },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '../public/js/theme.js';
import { createSunClock, isDaytime, systemThemeKnown } from '../public/js/sun.js';
import { storage } from '../public/js/storage.js';
import { memoryStorage } from './helpers.js';

/** A matchMedia that answers the light and dark queries like a real browser. */
function fakeSystem(prefersLight) {
  const listeners = [];
  const state = { light: prefersLight };
  const matchMedia = (q) => ({
    get matches() {
      if (q.includes('light')) return state.light;
      if (q.includes('dark')) return !state.light;
      return false;
    },
    addEventListener: (_, fn) => listeners.push(fn),
  });
  return {
    matchMedia,
    change(light) {
      state.light = light;
      listeners.forEach((fn) => fn());
    },
  };
}

const CHROME_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
const TESLA_UA = 'Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/88.0.4324.150 Chrome/88.0.4324.150 Safari/537.36 Tesla/2024.8.9';

function fakeSun(day) {
  const sun = { day, running: false, isDay: () => sun.day, start: () => (sun.running = true), stop: () => (sun.running = false) };
  return sun;
}

test('theme follows the system and switches live while on auto', () => {
  const system = fakeSystem(false);
  const root = { dataset: {} };
  initTheme({ root, storage: memoryStorage(), matchMedia: system.matchMedia, userAgent: CHROME_UA });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.themeSource, 'system');
  system.change(true);
  assert.equal(root.dataset.theme, 'light');
});

test('toggle flips light/dark and returns to auto when it lands on the system theme', () => {
  const system = fakeSystem(false); // system is dark
  const root = { dataset: {} };
  const store = memoryStorage();
  const theme = initTheme({ root, storage: store, matchMedia: system.matchMedia, userAgent: CHROME_UA });
  theme.toggle();
  assert.equal(root.dataset.theme, 'light');
  assert.equal(theme.pref, 'light');
  assert.equal(store.getItem('settings:theme'), 'light');
  theme.toggle();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(theme.pref, 'auto');
});

test('the system theme counts as unknown in Tesla\'s browser or when the query is unsupported', () => {
  assert.equal(systemThemeKnown({ matchMedia: fakeSystem(true).matchMedia, userAgent: CHROME_UA }), true);
  assert.equal(systemThemeKnown({ matchMedia: fakeSystem(true).matchMedia, userAgent: TESLA_UA }), false);
  assert.equal(systemThemeKnown({ matchMedia: () => ({ matches: false }), userAgent: CHROME_UA }), false);
  assert.equal(systemThemeKnown({ matchMedia: undefined, userAgent: CHROME_UA }), false);
});

test('auto follows the sun in Tesla\'s browser, and the sun clock only runs on auto', () => {
  const sun = fakeSun(false); // night
  const root = { dataset: {} };
  const theme = initTheme({ root, storage: memoryStorage(), matchMedia: fakeSystem(true).matchMedia, userAgent: TESLA_UA, sunClock: sun });
  assert.equal(root.dataset.theme, 'dark'); // browser claims "light", but it's night
  assert.equal(root.dataset.themeSource, 'sun');
  assert.equal(sun.running, true);
  sun.day = true;
  theme.set('auto'); // re-apply, as the minute timer would
  assert.equal(root.dataset.theme, 'light');
  theme.set('dark');
  assert.equal(sun.running, false);
  // Toggle at daytime from forced dark: light is what auto picks, so it goes back to auto.
  theme.toggle();
  assert.equal(theme.pref, 'auto');
  assert.equal(sun.running, true);
});

test('isDaytime uses the sun position, or 07:00–19:00 without a location', () => {
  const shanghai = { lat: 31.2, lng: 121.5 };
  assert.equal(isDaytime(new Date('2026-06-21T04:00:00Z'), shanghai), true); // 12:00 local
  assert.equal(isDaytime(new Date('2026-06-21T16:00:00Z'), shanghai), false); // 00:00 local
  assert.equal(isDaytime(new Date('2026-12-21T10:30:00Z'), shanghai), false); // 18:30 local, after a winter sunset
  const tromso = { lat: 69.6, lng: 18.9 };
  assert.equal(isDaytime(new Date('2026-06-21T23:00:00Z'), tromso), true); // midnight sun
  assert.equal(isDaytime(new Date(2026, 5, 21, 12, 0), null), true);
  assert.equal(isDaytime(new Date(2026, 5, 21, 22, 0), null), false);
});

test('sun clock asks for the location once, stores it coarsely, and respects a "no"', () => {
  let t = 1_000_000;
  const store = memoryStorage();
  const calls = [];
  const geolocation = {
    getCurrentPosition: (ok, fail) => calls.push({ ok, fail }),
  };
  const noTimer = { setTimer: () => 1, clearTimer: () => {} };
  let changed = 0;
  const clock = createSunClock({ storage: store, geolocation, now: () => t, onChange: () => changed++, ...noTimer });
  clock.start();
  assert.equal(calls.length, 1);
  calls[0].ok({ coords: { latitude: 31.23456, longitude: 121.47321 } });
  assert.deepEqual(clock.coords, { lat: 31.2, lng: 121.5, at: t });
  assert.deepEqual(JSON.parse(store.getItem('sun:coords')), { lat: 31.2, lng: 121.5, at: t });
  assert.equal(changed, 1);

  // A fresh clock within a day reuses the stored location without asking.
  const again = createSunClock({ storage: store, geolocation, now: () => t + 1000, ...noTimer });
  again.start();
  assert.equal(calls.length, 1);

  // Declined: don't ask again for a month.
  const store2 = memoryStorage();
  const c2 = createSunClock({ storage: store2, geolocation, now: () => t, ...noTimer });
  c2.start();
  calls[1].fail({ code: 1 });
  const c3 = createSunClock({ storage: store2, geolocation, now: () => t + 60_000, ...noTimer });
  c3.start();
  assert.equal(calls.length, 2);
});

test('storage falls back gracefully and round-trips values', () => {
  storage.setItem('k', 'v');
  assert.equal(storage.getItem('k'), 'v');
  storage.removeItem('k');
  assert.equal(storage.getItem('k'), null);
});

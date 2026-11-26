import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '../public/js/theme.js';
import { storage } from '../public/js/storage.js';
import { memoryStorage } from './helpers.js';

function fakeSystem(prefersLight) {
  const listeners = [];
  const mql = {
    matches: prefersLight,
    addEventListener: (_, fn) => listeners.push(fn),
  };
  globalThis.matchMedia = () => mql;
  return {
    change(light) {
      mql.matches = light;
      listeners.forEach((fn) => fn());
    },
  };
}

test('theme follows the system and switches live while on auto', () => {
  const system = fakeSystem(false);
  const root = { dataset: {} };
  initTheme({ root, storage: memoryStorage() });
  assert.equal(root.dataset.theme, 'dark');
  system.change(true);
  assert.equal(root.dataset.theme, 'light');
});

test('toggle flips light/dark and returns to auto when it lands on the system theme', () => {
  fakeSystem(false); // system is dark
  const root = { dataset: {} };
  const store = memoryStorage();
  const theme = initTheme({ root, storage: store });
  theme.toggle();
  assert.equal(root.dataset.theme, 'light');
  assert.equal(theme.pref, 'light');
  assert.equal(store.getItem('settings:theme'), 'light');
  theme.toggle();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(theme.pref, 'auto');
});

test('storage falls back gracefully and round-trips values', () => {
  storage.setItem('k', 'v');
  assert.equal(storage.getItem('k'), 'v');
  storage.removeItem('k');
  assert.equal(storage.getItem('k'), null);
});

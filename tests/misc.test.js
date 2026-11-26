import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock } from '../public/js/clock.js';
import { averageColor, rgbToHsl, themeFromColor } from '../public/js/color.js';
import { resolveTheme } from '../public/js/theme.js';
import { STRINGS, resolveLang, setLang, t } from '../public/js/i18n.js';
import { DEFAULTS, loadSettings, sanitize, saveSettings } from '../public/js/settings.js';
import { memoryStorage } from './helpers.js';

test('clock interpolates while playing and holds while paused', () => {
  let now = 0;
  const c = new PlaybackClock({ now: () => now });
  c.sync({ trackId: 'a', progressMs: 1000, sampledAt: 0, isPlaying: true, durationMs: 10_000 });
  now = 500;
  assert.equal(c.position(), 1500);
  c.setPlaying(false);
  now = 5000;
  assert.equal(c.position(), 1500);
  assert.equal(c.remaining(), Infinity);
});

test('clock ignores small jitter but accepts seeks and new tracks', () => {
  let now = 0;
  const c = new PlaybackClock({ now: () => now, jitterMs: 250 });
  c.sync({ trackId: 'a', progressMs: 1000, sampledAt: 0, isPlaying: true, durationMs: 10_000 });
  now = 2000;
  assert.equal(c.sync({ trackId: 'a', progressMs: 3100, sampledAt: 2000, isPlaying: true, durationMs: 10_000 }), false);
  assert.equal(c.position(), 3000);
  assert.equal(c.sync({ trackId: 'a', progressMs: 8000, sampledAt: 2000, isPlaying: true, durationMs: 10_000 }), true);
  assert.equal(c.position(), 8000);
  assert.equal(c.sync({ trackId: 'b', progressMs: 8050, sampledAt: 2000, isPlaying: true, durationMs: 10_000 }), true);
  now = 100_000;
  assert.equal(c.position(), 10_000); // clamped to duration
});

test('theme resolution follows the system when set to auto', () => {
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('bogus', true), 'light');
});

test('colour helpers produce readable theme colours', () => {
  const red = averageColor([255, 0, 0, 255, 250, 10, 10, 255, 0, 0, 0, 0]);
  assert.ok(red.r > 240 && red.g < 20);
  assert.equal(averageColor([0, 0, 0, 0]), null);
  assert.equal(Math.round(rgbToHsl({ r: 0, g: 0, b: 255 }).h), 240);
  const c = themeFromColor({ r: 30, g: 144, b: 255 });
  assert.match(c.dark, /^hsl\(\d+, \d+%, 24%\)$/);
  assert.match(c.light, /85%\)$/);
  assert.ok(c.accentDark);
  assert.equal(themeFromColor({ r: 128, g: 128, b: 128 }).accentDark, null);
});

test('language resolution prefers Chinese for any zh browser locale', () => {
  assert.equal(resolveLang('auto', ['zh-CN', 'en']), 'zh-CN');
  assert.equal(resolveLang('auto', ['zh-TW']), 'zh-CN');
  assert.equal(resolveLang('auto', ['en-US', 'zh-CN']), 'en');
  assert.equal(resolveLang('auto', []), 'en');
  assert.equal(resolveLang('en', ['zh-CN']), 'en');
});

test('every English string has a Chinese translation and placeholders match', () => {
  const en = STRINGS.en;
  const zh = STRINGS['zh-CN'];
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const k of Object.keys(en)) {
    const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(vars(zh[k]), vars(en[k]), `placeholder mismatch in ${k}`);
  }
  setLang('zh-CN');
  assert.equal(t('sync.earlier', { s: '0.5' }), '提前 0.5 秒');
  setLang('en');
  assert.equal(t('sync.earlier', { s: '0.5' }), '0.5s earlier');
  assert.equal(t('missing.key'), 'missing.key');
});

test('settings are validated and persisted', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadSettings(storage), { ...DEFAULTS });
  saveSettings({ ...DEFAULTS, fontScale: 5, offsetMs: 300, align: 'left', highlight: 'nope', karaoke: false }, storage);
  const s = loadSettings(storage);
  assert.equal(s.fontScale, 1.8);
  assert.equal(s.offsetMs, 300);
  assert.equal(s.align, 'left');
  assert.equal(s.highlight, 'default');
  assert.equal(s.karaoke, false);
  assert.deepEqual(sanitize('garbage'), { ...DEFAULTS });
  assert.deepEqual(loadSettings(memoryStorage({ 'settings:v1': '{not json' })), { ...DEFAULTS });
});

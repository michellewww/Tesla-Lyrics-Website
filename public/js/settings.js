// User adjustments, saved in localStorage on this device.
// (The light/dark preference lives in theme.js so it can be applied before first paint.)

const KEY = 'settings:v1';

export const DEFAULTS = Object.freeze({
  fontScale: 1, // 0.6 – 1.8
  lineGap: 1, // space between lyric lines, 0.5 – 2.5 × the default
  offsetMs: 0, // > 0 shows lyrics earlier, < 0 later
  align: 'center', // 'left' | 'center'
  karaoke: true, // character-by-character fill of the current line
  translation: true, // show bilingual translation lines
  simplified: true, // show Traditional Chinese as Simplified (opencc-js)
  highlight: 'default', // 'default' | 'cover' | 'green' | 'gold' | 'pink'
  background: 'blur', // 'blur' | 'color'
  layout: 'auto', // 'auto' | 'compact' (beside Tesla's driving view) | 'full' (full screen)
  lang: 'auto', // 'auto' | 'en' | 'zh-CN'
});

const CHOICES = {
  align: ['left', 'center'],
  highlight: ['default', 'cover', 'green', 'gold', 'pink'],
  background: ['blur', 'color'],
  layout: ['auto', 'compact', 'full'],
  lang: ['auto', 'en', 'zh-CN'],
};

export const LIMITS = { fontScale: [0.6, 1.8], lineGap: [0.5, 2.5], offsetMs: [-10_000, 10_000] };

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/** Validate an arbitrary object into a complete settings object. */
export function sanitize(input) {
  const s = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return s;
  if (Number.isFinite(input.fontScale)) s.fontScale = Math.round(clamp(input.fontScale, LIMITS.fontScale) * 100) / 100;
  if (Number.isFinite(input.lineGap)) s.lineGap = Math.round(clamp(input.lineGap, LIMITS.lineGap) * 100) / 100;
  if (Number.isFinite(input.offsetMs)) s.offsetMs = Math.round(clamp(input.offsetMs, LIMITS.offsetMs));
  for (const [k, allowed] of Object.entries(CHOICES)) if (allowed.includes(input[k])) s[k] = input[k];
  for (const k of ['karaoke', 'translation', 'simplified']) if (typeof input[k] === 'boolean') s[k] = input[k];
  return s;
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    return sanitize(JSON.parse(storage.getItem(KEY)));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(sanitize(settings)));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

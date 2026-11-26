// Traditional → Simplified Chinese, using opencc-js (the official JavaScript port of
// OpenCC, vendored in public/vendor/opencc-js). No conversion rules live here: where
// OpenCC leaves a character unconverted (e.g. the ambiguous 著), it stays Traditional.
// This module is loaded lazily, only when Chinese lyrics or titles show up.
import { Converter } from '../vendor/opencc-js/t2cn.js';

// Taiwan Traditional → Mainland Simplified, character conversion only ("tw" rather than
// "twp", so lyrics' wording isn't changed — e.g. 軟體 becomes 软体, not 软件).
const convert = Converter({ from: 'tw', to: 'cn' });

/** Convert Traditional Chinese in `text` to Simplified. Non-Chinese text is untouched. */
export function toSimplified(text) {
  return text ? convert(text) : text;
}

/**
 * Convert timed words while keeping their timing. The whole line is converted at once
 * (so OpenCC's phrase matching works across word boundaries), then cut back into the
 * original word lengths. If the lengths ever differ, each word is converted on its own.
 */
function simplifyWords(words) {
  const lengths = words.map((w) => Array.from(w.text).length);
  const converted = Array.from(toSimplified(words.map((w) => w.text).join('')));
  if (converted.length !== lengths.reduce((a, b) => a + b, 0)) {
    return words.map((w) => ({ ...w, text: toSimplified(w.text) }));
  }
  let at = 0;
  return words.map((w, i) => {
    const text = converted.slice(at, at + lengths[i]).join('');
    at += lengths[i];
    return { ...w, text };
  });
}

/** Convert parsed lyric lines (text, word timings and translations). */
export function simplifyLines(lines) {
  return lines.map((line) => {
    const out = { ...line, text: toSimplified(line.text) };
    if (line.translation) out.translation = toSimplified(line.translation);
    if (line.words) out.words = simplifyWords(line.words);
    return out;
  });
}

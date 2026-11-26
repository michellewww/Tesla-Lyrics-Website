// Simplified → Traditional Chinese, only for *searching* LRCLIB: many songs there are
// filed under Traditional titles and names (對等關係 / 李榮浩), and LRCLIB's search doesn't
// treat 对等关系 and 對等關係 as the same. Uses opencc-js (vendored); it is large (~1 MB),
// so this module is loaded only after a Chinese song wasn't found the usual way.
import { ConverterFactory, Locale } from '../vendor/opencc-js/cn2t.js';

// Simplified → standard Traditional is the expensive part (a ~1 MB phrase dictionary);
// build it once, lazily, and share it between the Taiwan and Hong Kong variants instead
// of building it twice. The output matches Converter({ from: 'cn', to: 'tw' | 'hk' }).
let toTraditional = null;
let toTW = null;
let toHK = null;
function build() {
  toTraditional ||= ConverterFactory(...Locale.from.cn);
  toTW ||= ConverterFactory(...Locale.to.tw);
  toHK ||= ConverterFactory(...Locale.to.hk);
}

const toTaiwan = (text) => (build(), toTW(toTraditional(text)));
const toHongKong = (text) => (build(), toHK(toTraditional(text)));

/** The converters themselves, so related strings (artist + album) can share one spelling. */
export const traditionalConverters = [toTaiwan, toHongKong];

/** Traditional spellings of `text` (Taiwan and Hong Kong forms, deduplicated). */
export function traditionalVariants(text) {
  if (!text) return [];
  return [...new Set([toTaiwan(text), toHongKong(text)])];
}

// Simplified → Traditional Chinese, only for *searching* LRCLIB: many songs there are
// filed under Traditional titles and names (對等關係 / 李榮浩), and LRCLIB's search doesn't
// treat 对等关系 and 對等關係 as the same. Uses opencc-js (vendored); it is large (~1 MB),
// so this module is loaded only after a Chinese song wasn't found the usual way.
import { Converter } from '../vendor/opencc-js/cn2t.js';

const toTaiwan = Converter({ from: 'cn', to: 'tw' });
const toHongKong = Converter({ from: 'cn', to: 'hk' });

/** The converters themselves, so related strings (artist + album) can share one spelling. */
export const traditionalConverters = [toTaiwan, toHongKong];

/** Traditional spellings of `text` (Taiwan and Hong Kong forms, deduplicated). */
export function traditionalVariants(text) {
  if (!text) return [];
  return [...new Set([toTaiwan(text), toHongKong(text)])];
}

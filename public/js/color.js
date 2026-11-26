// Album-art colour → background colours for the dark and light themes,
// like Spotify's lyrics view (solid colour taken from the cover).

/**
 * Average colour of RGBA pixel data, weighted toward saturated mid-tones so a
 * cover with a white border or black background still gives its "real" colour.
 * @param {Uint8ClampedArray|number[]} data RGBA bytes
 */
export function averageColor(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const R = data[i];
    const G = data[i + 1];
    const B = data[i + 2];
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const sat = max ? (max - min) / max : 0;
    const lum = (max + min) / 510;
    const weight = 0.05 + sat * (1 - Math.abs(lum - 0.5) * 2);
    r += R * weight;
    g += G * weight;
    b += B * weight;
    w += weight;
  }
  if (!w) return null;
  return { r: r / w, g: g / w, b: b / w };
}

export function rgbToHsl({ r, g, b }) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

const hsl = (h, s, l) => `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;

/**
 * Background colours for both themes. Lightness is fixed so lyrics text always has
 * strong contrast: white text on the dark variant, near-black text on the light one.
 */
export function themeFromColor(rgb) {
  const { h, s } = rgbToHsl(rgb);
  const sat = Math.min(s, 0.6);
  // A vivid version of the cover colour for the "Album" highlight option. Nearly grey
  // covers don't have a usable hue, so they get null and the default highlight.
  const vivid = s >= 0.12 ? Math.min(0.9, Math.max(0.55, s * 1.2)) : null;
  return {
    dark: hsl(h, sat, 0.24),
    darkDeep: hsl(h, sat, 0.1),
    light: hsl(h, sat * 0.85, 0.85),
    lightDeep: hsl(h, sat * 0.85, 0.94),
    accentDark: vivid === null ? null : hsl(h, vivid, 0.7),
    accentLight: vivid === null ? null : hsl(h, vivid, 0.33),
  };
}

/**
 * Browser-only: load the cover once and return
 *   rgb      – its average colour (for theme colours), and
 *   backdrop – a tiny pre-blurred JPEG data URL for the background.
 * Blurring 64×64 pixels on a canvas and letting the GPU scale it up is far cheaper
 * than a full-screen CSS blur, which matters on in-car browsers.
 * Either field is null if the image can't be read.
 */
export function analyzeCover(url) {
  return new Promise((resolve) => {
    if (!url) return resolve({ rgb: null, backdrop: null });
    const img = new Image();
    img.crossOrigin = 'anonymous'; // i.scdn.co sends Access-Control-Allow-Origin: *
    img.decoding = 'async';
    img.onload = () => {
      let rgb = null;
      let backdrop = null;
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        rgb = averageColor(ctx.getImageData(0, 0, size, size).data);
      } catch {
        /* tainted canvas or decode error */
      }
      try {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.filter = 'blur(5px) saturate(1.4)'; // ignored where unsupported; upscaling still softens
        ctx.drawImage(img, -10, -10, size + 20, size + 20); // overdraw so the blur has no dark edges
        backdrop = canvas.toDataURL('image/jpeg', 0.85);
      } catch {
        /* ignore */
      }
      resolve({ rgb, backdrop });
    };
    img.onerror = () => resolve({ rgb: null, backdrop: null });
    img.src = url;
  });
}

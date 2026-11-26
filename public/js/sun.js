// Day or night by the sun, for browsers that can't say whether the device is in light or
// dark mode (Tesla's browser doesn't pass the car's day/night display setting through).
// Sun position comes from suncalc (vendored in public/vendor/suncalc). The location is
// asked for once, rounded to ~10 km, kept only on this device and never sent anywhere.
import { getPosition } from '../vendor/suncalc/suncalc.js';

const KEY_COORDS = 'sun:coords';
const KEY_DENIED = 'sun:denied';
const RELOCATE_AFTER_MS = 24 * 60 * 60 * 1000; // refresh the location at most daily
const ASK_AGAIN_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // after a "no", don't ask for a month
// The Sun's centre is 0.833° below the horizon at the moment of sunrise/sunset
// (refraction plus its own radius) — the same definition suncalc uses for those times.
const SUNRISE_ALTITUDE = (-0.833 * Math.PI) / 180;
// Without a location: light from 07:00 to 19:00 local time.
const FALLBACK_DAY = [7, 19];

/** Is it daytime at `date`? `coords` is {lat, lng}; without it a fixed 07:00–19:00 is used. */
export function isDaytime(date, coords) {
  if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    return getPosition(date, coords.lat, coords.lng).altitude > SUNRISE_ALTITUDE;
  }
  const h = date.getHours();
  return h >= FALLBACK_DAY[0] && h < FALLBACK_DAY[1];
}

/** Tesla's in-car browser identifies itself with "Tesla/<version>" in its user agent. */
export function isTeslaBrowser(userAgent = globalThis.navigator?.userAgent || '') {
  return /\bTesla\//.test(userAgent);
}

/**
 * Whether the browser really reports the device's light/dark mode. Tesla's browser
 * answers the media query but always says "light", so it's treated as unknown.
 */
export function systemThemeKnown({ matchMedia = globalThis.matchMedia, userAgent = globalThis.navigator?.userAgent || '' } = {}) {
  if (isTeslaBrowser(userAgent)) return false;
  if (!matchMedia) return false;
  return Boolean(matchMedia('(prefers-color-scheme: dark)').matches || matchMedia('(prefers-color-scheme: light)').matches);
}

function readJson(storage, key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}

/**
 * Tracks day/night for the current location. start() looks the location up (once a day
 * at most) and then calls onChange every minute so the theme can flip at sunrise/sunset.
 */
export function createSunClock({
  storage,
  geolocation = globalThis.navigator?.geolocation,
  now = () => Date.now(),
  onChange = () => {},
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id),
} = {}) {
  let coords = readJson(storage, KEY_COORDS);
  let timer = null;

  function locate() {
    if (!geolocation) return;
    if (coords?.at && now() - coords.at < RELOCATE_AFTER_MS) return;
    const deniedAt = Number(storage.getItem(KEY_DENIED));
    if (deniedAt && now() - deniedAt < ASK_AGAIN_AFTER_MS && !coords) return;
    geolocation.getCurrentPosition(
      (pos) => {
        // ~10 km precision is plenty for sunrise/sunset and keeps the stored value coarse.
        coords = {
          lat: Math.round(pos.coords.latitude * 10) / 10,
          lng: Math.round(pos.coords.longitude * 10) / 10,
          at: now(),
        };
        try {
          storage.setItem(KEY_COORDS, JSON.stringify(coords));
          storage.removeItem(KEY_DENIED);
        } catch {
          /* ignore */
        }
        onChange();
      },
      (err) => {
        if (err?.code === 1) {
          try {
            storage.setItem(KEY_DENIED, String(now()));
          } catch {
            /* ignore */
          }
        }
      },
      { enableHighAccuracy: false, maximumAge: RELOCATE_AFTER_MS, timeout: 20_000 },
    );
  }

  return {
    isDay: () => isDaytime(new Date(now()), coords),
    get coords() {
      return coords;
    },
    start() {
      if (timer !== null) return;
      locate();
      timer = setTimer(onChange, 60_000);
    },
    stop() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
  };
}

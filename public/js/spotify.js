// Minimal Spotify Web API client for the player endpoints this app needs.
// All of these remain available to Development Mode apps after Spotify's Feb 2026 changes.

const API = 'https://api.spotify.com/v1';

export class AuthRequiredError extends Error {
  constructor() {
    super('Spotify login required');
    this.name = 'AuthRequiredError';
  }
}

export class RateLimitError extends Error {
  constructor(retryAfterSec) {
    super(`Rate limited by Spotify; retry in ${retryAfterSec}s`);
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

export class ApiError extends Error {
  constructor(status, message, reason) {
    super(message || `Spotify API error ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

/** Convert a currently-playing response into the shape the app uses. */
export function normalizePlayback(data, sampledAt) {
  if (!data) return { active: false, isPlaying: false, type: null, track: null, progressMs: 0, sampledAt };
  const type = data.currently_playing_type || (data.item?.type ?? null);
  const item = data.item;
  let track = null;
  if (item && item.type === 'track') {
    const images = item.album?.images || [];
    track = {
      id: item.id || item.uri || `${item.name}|${item.artists?.[0]?.name}`,
      name: item.name,
      artists: (item.artists || []).map((a) => a.name),
      album: item.album?.name || '',
      durationMs: item.duration_ms || 0,
      image: images[0]?.url || null,
      imageSmall: images[images.length - 1]?.url || images[0]?.url || null,
      imageMedium: images[1]?.url || images[0]?.url || null,
      isLocal: Boolean(item.is_local),
    };
  } else if (item && item.type === 'episode') {
    const images = item.images || item.show?.images || [];
    track = {
      id: item.id || item.uri,
      name: item.name,
      artists: [item.show?.name || 'Podcast'],
      album: item.show?.name || '',
      durationMs: item.duration_ms || 0,
      image: images[0]?.url || null,
      imageSmall: images[images.length - 1]?.url || null,
      isEpisode: true,
    };
  }
  return {
    active: true,
    isPlaying: Boolean(data.is_playing),
    type,
    track,
    progressMs: data.progress_ms ?? 0,
    sampledAt,
  };
}

export function createSpotify({ auth, fetchFn = (...a) => globalThis.fetch(...a), now = () => performance.now() }) {
  async function api(method, path, { query } = {}, retried = false) {
    const token = await auth.getAccessToken();
    if (!token) throw new AuthRequiredError();
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const res = await fetchFn(`${API}${path}${qs}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401 && !retried) {
      const fresh = await auth.refresh();
      if (!fresh) throw new AuthRequiredError();
      return api(method, path, { query }, true);
    }
    if (res.status === 401) throw new AuthRequiredError();
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new RateLimitError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5);
    }
    if (res.status === 204) return null;

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* some player endpoints return an empty or non-JSON body */
    }
    if (!res.ok) throw new ApiError(res.status, body?.error?.message, body?.error?.reason);
    return body;
  }

  return {
    async nowPlaying() {
      const t0 = now();
      const data = await api('GET', '/me/player/currently-playing', { query: { additional_types: 'episode' } });
      const t1 = now();
      // progress_ms was measured roughly halfway through the round trip.
      return normalizePlayback(data, (t0 + t1) / 2);
    },
    play: () => api('PUT', '/me/player/play'),
    pause: () => api('PUT', '/me/player/pause'),
    next: () => api('POST', '/me/player/next'),
    previous: () => api('POST', '/me/player/previous'),
    seek: (ms) => api('PUT', '/me/player/seek', { query: { position_ms: String(Math.max(0, Math.round(ms))) } }),
  };
}

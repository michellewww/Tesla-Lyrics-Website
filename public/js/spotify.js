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
  let fastestRoundTrip = Infinity; // ms; the best estimate of plain network latency

  /** `timing`, if given, receives when the request went out and when the response arrived. */
  async function api(method, path, { query, headers, timing } = {}, retried = false) {
    const token = await auth.getAccessToken();
    if (!token) throw new AuthRequiredError();
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    if (timing) timing.sent = now();
    const res = await fetchFn(`${API}${path}${qs}`, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
    });
    if (timing) timing.received = now();

    if (res.status === 401 && !retried) {
      const fresh = await auth.refresh();
      if (!fresh) throw new AuthRequiredError();
      return api(method, path, { query, headers, timing }, true);
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
      const timing = {};
      const data = await api('GET', '/me/player/currently-playing', { query: { additional_types: 'episode' }, timing });
      // Spotify measures progress_ms just before it answers, so about half a *plain* round
      // trip before the response arrives. Only the request itself is timed (not a token
      // refresh), and the fastest round trip seen stands in for the network latency: the
      // first request after a page load also pays for connection setup, which would make
      // the position look older than it is and the lyrics lag.
      const roundTrip = Math.max(0, timing.received - timing.sent);
      fastestRoundTrip = Math.min(fastestRoundTrip, roundTrip);
      return normalizePlayback(data, timing.received - fastestRoundTrip / 2);
    },
    /**
     * The playing track's names in English. Spotify localises names (notably Chinese,
     * Japanese and Korean artists) by the browser's language, while LRCLIB often has
     * the English ones. Returns null if a different track is playing by now.
     */
    async englishNames(trackId) {
      const data = await api('GET', '/me/player/currently-playing', { headers: { 'Accept-Language': 'en' } });
      const item = data?.item;
      if (!item || item.type !== 'track' || item.id !== trackId) return null;
      return { name: item.name, artists: (item.artists || []).map((a) => a.name), album: item.album?.name || '' };
    },
    /** The Spotify account this app is signed in to (its display name). */
    async profile() {
      const me = await api('GET', '/me');
      return me?.display_name || me?.id || null;
    },

    /**
     * What Spotify itself reports for this account — for the "Check Spotify connection"
     * button. In a Tesla, the car's Spotify may be signed in to a different account
     * (e.g. Tesla's built-in one), in which case the car won't be listed here.
     */
    async connectionInfo() {
      const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
      const [me, player, devices] = await Promise.all([
        settle(api('GET', '/me')),
        settle(api('GET', '/me/player', { query: { additional_types: 'episode' } })),
        settle(api('GET', '/me/player/devices')),
      ]);
      const error = [me, player, devices].find((r) => r.error)?.error || null;
      if (error instanceof AuthRequiredError) throw error;
      const item = player.value?.item;
      return {
        account: me.value?.display_name || me.value?.id || null,
        nowPlaying: item ? `${item.name} – ${(item.artists || [item.show]).map((a) => a?.name).filter(Boolean).join(', ')}` : null,
        isPlaying: Boolean(player.value?.is_playing),
        playingOn: player.value?.device?.name || null,
        devices: (devices.value?.devices || []).map((d) => ({
          name: d.name,
          type: d.type,
          active: Boolean(d.is_active),
          restricted: Boolean(d.is_restricted),
          privateSession: Boolean(d.is_private_session),
        })),
        error,
      };
    },
    play: () => api('PUT', '/me/player/play'),
    pause: () => api('PUT', '/me/player/pause'),
    next: () => api('POST', '/me/player/next'),
    previous: () => api('POST', '/me/player/previous'),
    seek: (ms) => api('PUT', '/me/player/seek', { query: { position_ms: String(Math.max(0, Math.round(ms))) } }),
  };
}

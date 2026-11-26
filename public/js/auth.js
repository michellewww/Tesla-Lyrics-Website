// Spotify login using the Authorization Code flow with PKCE.
// https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
// No client secret is involved, which is what makes this safe for a static site.

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const KEY_TOKENS = 'spotify:tokens';
const KEY_VERIFIER = 'spotify:pkce_verifier';
const KEY_STATE = 'spotify:pkce_state';

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength = 48, cryptoImpl = globalThis.crypto) {
  return base64url(cryptoImpl.getRandomValues(new Uint8Array(byteLength)));
}

export async function codeChallenge(verifier, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The URL Spotify should send the user back to: this page, without query/hash/index.html. */
export function redirectUriFor(loc) {
  return loc.origin + loc.pathname.replace(/index\.html$/, '');
}

export function createAuth({
  clientId,
  redirectUri,
  scopes,
  storage = globalThis.localStorage,
  fetchFn = (...a) => globalThis.fetch(...a),
  navigate = (url) => globalThis.location.assign(url),
  now = () => Date.now(),
  cryptoImpl = globalThis.crypto,
}) {
  let refreshing = null;

  function readTokens() {
    try {
      return JSON.parse(storage.getItem(KEY_TOKENS)) || null;
    } catch {
      return null;
    }
  }

  function saveTokens(data, previous) {
    const tokens = {
      accessToken: data.access_token,
      // Spotify may rotate the refresh token; keep the old one if it doesn't send a new one.
      refreshToken: data.refresh_token || previous?.refreshToken || null,
      // Refresh a minute early so a request never goes out with a token about to expire.
      expiresAt: now() + (Number(data.expires_in) || 3600) * 1000 - 60_000,
      scope: data.scope || previous?.scope || '',
    };
    storage.setItem(KEY_TOKENS, JSON.stringify(tokens));
    return tokens;
  }

  async function postToken(params) {
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...params }).toString(),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      throw new AuthError(data?.error_description || data?.error || `Token request failed (${res.status})`, data?.error);
    }
    return data;
  }

  return {
    /** Send the browser to Spotify's consent page. */
    async login() {
      const verifier = randomToken(48, cryptoImpl); // 64 chars, within RFC 7636's 43–128
      const state = randomToken(16, cryptoImpl);
      storage.setItem(KEY_VERIFIER, verifier);
      storage.setItem(KEY_STATE, state);
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge_method: 'S256',
        code_challenge: await codeChallenge(verifier, cryptoImpl),
        scope: scopes.join(' '),
        state,
      });
      navigate(`${AUTHORIZE_URL}?${params}`);
    },

    /**
     * If `url` is Spotify redirecting back with ?code= or ?error=, finish the login.
     * Returns true when the URL was an auth redirect (so the caller can clean the URL).
     */
    async handleRedirect(url) {
      const u = new URL(url);
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      if (!code && !error) return false;

      const expectedState = storage.getItem(KEY_STATE);
      const verifier = storage.getItem(KEY_VERIFIER);
      storage.removeItem(KEY_STATE);
      storage.removeItem(KEY_VERIFIER);

      if (error) throw new AuthError(error === 'access_denied' ? 'Spotify login was cancelled.' : `Spotify login failed: ${error}`, error);
      if (!verifier || !expectedState || u.searchParams.get('state') !== expectedState) {
        throw new AuthError('Login could not be verified (state mismatch). Please try again.', 'state_mismatch');
      }

      const data = await postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      saveTokens(data, null);
      return true;
    },

    isLoggedIn() {
      const t = readTokens();
      return Boolean(t?.accessToken && (t.refreshToken || t.expiresAt > now()));
    },

    /** A valid access token, refreshing if needed. Returns null when the user must log in again. */
    async getAccessToken() {
      const t = readTokens();
      if (!t) return null;
      if (t.accessToken && t.expiresAt > now()) return t.accessToken;
      return this.refresh();
    },

    /** Exchange the refresh token for a new access token. Concurrent callers share one request. */
    async refresh() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const t = readTokens();
        if (!t?.refreshToken) {
          storage.removeItem(KEY_TOKENS);
          return null;
        }
        try {
          const data = await postToken({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
          return saveTokens(data, t).accessToken;
        } catch (e) {
          // invalid_grant = refresh token revoked/expired; anything else is likely transient.
          if (e instanceof AuthError && e.code === 'invalid_grant') {
            storage.removeItem(KEY_TOKENS);
            return null;
          }
          throw e;
        }
      })();
      try {
        return await refreshing;
      } finally {
        refreshing = null;
      }
    },

    logout() {
      storage.removeItem(KEY_TOKENS);
      storage.removeItem(KEY_VERIFIER);
      storage.removeItem(KEY_STATE);
    },
  };
}

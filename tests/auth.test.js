import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, base64url, codeChallenge, createAuth, randomToken, redirectUriFor } from '../public/js/auth.js';
import { fakeFetch, jsonResponse, memoryStorage } from './helpers.js';

const REDIRECT = 'https://example.github.io/Tesla-Lyrics-Website/';

test('PKCE challenge matches the RFC 7636 test vector', async () => {
  const challenge = await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('random verifier is URL-safe and long enough', () => {
  const v = randomToken(48);
  assert.match(v, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(base64url(new Uint8Array([251, 255])), '-_8');
});

test('redirect URI strips query, hash and index.html', () => {
  assert.equal(redirectUriFor(new URL('https://a.github.io/repo/index.html?code=1#x')), 'https://a.github.io/repo/');
  assert.equal(redirectUriFor(new URL('http://127.0.0.1:5173/?demo')), 'http://127.0.0.1:5173/');
});

function setup({ fetchFn, storage = memoryStorage(), now = () => 1_000_000 } = {}) {
  let navigatedTo = null;
  const auth = createAuth({
    clientId: 'cid',
    redirectUri: REDIRECT,
    scopes: ['user-read-currently-playing', 'user-read-playback-state'],
    storage,
    fetchFn,
    navigate: (u) => (navigatedTo = u),
    now,
  });
  return { auth, storage, nav: () => navigatedTo };
}

test('login → redirect → token exchange', async () => {
  const fetchFn = fakeFetch(() => jsonResponse(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 's' }));
  const { auth, storage, nav } = setup({ fetchFn });
  await auth.login();

  const url = new URL(nav());
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('scope'), 'user-read-currently-playing user-read-playback-state');
  const verifier = storage.getItem('spotify:pkce_verifier');
  assert.equal(url.searchParams.get('code_challenge'), await codeChallenge(verifier));

  const state = url.searchParams.get('state');
  assert.equal(await auth.handleRedirect(`${REDIRECT}?code=XYZ&state=${state}`), true);
  const body = new URLSearchParams(fetchFn.calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'XYZ');
  assert.equal(body.get('code_verifier'), verifier);
  assert.equal(body.get('client_id'), 'cid');
  assert.equal(await auth.getAccessToken(), 'AT');
  assert.equal(auth.isLoggedIn(), true);
  assert.equal(storage.getItem('spotify:pkce_verifier'), null);
});

test('handleRedirect ignores normal URLs and rejects a state mismatch', async () => {
  const { auth } = setup({ fetchFn: fakeFetch(() => jsonResponse(200, {})) });
  assert.equal(await auth.handleRedirect(REDIRECT), false);
  await auth.login();
  await assert.rejects(auth.handleRedirect(`${REDIRECT}?code=1&state=wrong`), (e) => e instanceof AuthError && e.code === 'state_mismatch');
});

test('handleRedirect surfaces access_denied', async () => {
  const { auth } = setup({ fetchFn: fakeFetch(() => jsonResponse(200, {})) });
  await assert.rejects(auth.handleRedirect(`${REDIRECT}?error=access_denied`), (e) => e.code === 'access_denied');
});

test('expired token is refreshed once for concurrent callers, keeping the old refresh token', async () => {
  let clock = 0;
  const storage = memoryStorage({
    'spotify:tokens': JSON.stringify({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: 10 }),
  });
  const fetchFn = fakeFetch(() => jsonResponse(200, { access_token: 'NEW', expires_in: 3600 }));
  const { auth } = setup({ fetchFn, storage, now: () => clock });
  clock = 100;
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(a, 'NEW');
  assert.equal(b, 'NEW');
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(new URLSearchParams(fetchFn.calls[0].init.body).get('grant_type'), 'refresh_token');
  assert.equal(JSON.parse(storage.getItem('spotify:tokens')).refreshToken, 'RT');
});

test('revoked refresh token logs the user out', async () => {
  const storage = memoryStorage({
    'spotify:tokens': JSON.stringify({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0 }),
  });
  const fetchFn = fakeFetch(() => jsonResponse(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' }));
  const { auth } = setup({ fetchFn, storage, now: () => 5 });
  assert.equal(await auth.getAccessToken(), null);
  assert.equal(storage.getItem('spotify:tokens'), null);
  assert.equal(auth.isLoggedIn(), false);
});

test('a transient refresh failure keeps the session', async () => {
  const storage = memoryStorage({
    'spotify:tokens': JSON.stringify({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0 }),
  });
  const fetchFn = fakeFetch(() => jsonResponse(503, { error: 'server_error' }));
  const { auth } = setup({ fetchFn, storage, now: () => 5 });
  await assert.rejects(auth.getAccessToken());
  assert.notEqual(storage.getItem('spotify:tokens'), null);
});

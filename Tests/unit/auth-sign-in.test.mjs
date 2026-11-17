// A whole Auth0 sign-in on the runtime, with the auth0-spa-js build PrepViz ships (found in ../cine-blocking; the test
// skips when it isn't there). Each page start is a fresh runtime, as each Unreal restart is, and the host's store
// carries over. The token endpoint is a stub, so no request leaves the machine:
//   1. loginWithRedirect opens the authorize URL in the system browser; the page stays, its transaction saved.
//   2. The host brings the browser's callback back as a restart at /auth/callback?code&state (JsgbAddress.cpp).
//   3. handleRedirectCallback finds the transaction, exchanges the code (form POST to /oauth/token) and signs in.
//   4. A later start is signed in from the store and refreshes with the refresh token.
//   5. logout opens /v2/logout in the system browser with the origin as returnTo.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
// Node's own URL for the test's checks: the page's globals are the runtime's.
import {URL, URLSearchParams, fileURLToPath, pathToFileURL} from 'node:url';
import {bootPage, restartAddress, restarted, stubHost} from './browser-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pnpm = path.resolve(root, '../cine-blocking/node_modules/.pnpm');
const sdkDir = fs.existsSync(pnpm) ? fs.readdirSync(pnpm).filter(d => d.startsWith('@auth0+auth0-spa-js@')).sort().at(-1) : undefined;
const sdkFile = sdkDir && path.join(pnpm, sdkDir, 'node_modules/@auth0/auth0-spa-js/dist/auth0-spa-js.production.esm.js');

const ORIGIN = 'http://localhost:5180', DOMAIN = 'auth.prechecklist.com', CLIENT = 'test-client', AUDIENCE = 'https://api.cineblocking.prechecklist.com';
const g = globalThis;
const b64url = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
/** An ID token the SDK accepts: it checks the claims, not the signature. */
const idToken = claims => [b64url({alg: 'RS256', typ: 'JWT'}), b64url({iss: `https://${DOMAIN}/`, aud: CLIENT, sub: 'auth0|jd', name: 'JD',
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims}), b64url('signature')].join('.');

let boots = 0;
/** A page start: a fresh runtime with this host, then a fresh copy of the SDK and a client as PrepViz configures it. */
async function start(host) {
  const page = await bootPage(host);
  const {Auth0Client} = await import(pathToFileURL(sdkFile).href + '?boot=' + ++boots);
  const client = new Auth0Client({domain: DOMAIN, clientId: CLIENT, cacheLocation: 'localstorage', useRefreshTokens: true, useRefreshTokensFallback: true,
    authorizationParams: {redirect_uri: `${g.location.origin}/auth/callback`, audience: AUDIENCE, scope: 'openid profile email offline_access'}});
  return {page, client};
}

test('an Auth0 sign-in, a later start and a sign-out on the runtime', {skip: !sdkFile && 'auth0-spa-js is not installed in ../cine-blocking'}, async () => {
  const store = new Map();
  let transaction = null;
  const tokenReplies = [];
  const http = request => {
    if (request.method === 'POST' && request.url === `https://${DOMAIN}/oauth/token`) {
      const form = new URLSearchParams(request.body);
      const reply = form.get('grant_type') === 'authorization_code'
        ? {access_token: 'access-1', refresh_token: 'refresh-1', id_token: idToken({nonce: transaction.nonce}), scope: 'openid profile email offline_access', expires_in: 86400, token_type: 'Bearer'}
        : {access_token: 'access-2', refresh_token: 'refresh-2', id_token: idToken({}), scope: 'openid profile email offline_access', expires_in: 86400, token_type: 'Bearer'};
      tokenReplies.push(form.get('grant_type'));
      return {status: 200, body: reply};
    }
    return {status: 404, body: {}};
  };

  // 1. The first start, signed out: sign-in opens the system browser.
  const first = stubHost({origin: ORIGIN, store, http});
  let {client, page} = await start(first.host);
  await client.checkSession();
  assert.equal(await client.getUser(), undefined);
  await client.loginWithRedirect();
  assert.equal(first.seen.reloads, 0, 'the page stays while the browser signs in');
  assert.equal(first.seen.opened.length, 1);
  const authorize = new URL(first.seen.opened[0]);
  assert.equal(authorize.origin + authorize.pathname, `https://${DOMAIN}/authorize`);
  const params = Object.fromEntries(authorize.searchParams);
  assert.equal(params.redirect_uri, `${ORIGIN}/auth/callback`);
  assert.deepEqual([params.response_type, params.code_challenge_method, params.client_id, params.audience], ['code', 'S256', CLIENT, AUDIENCE]);
  transaction = JSON.parse(JSON.parse(store.get(`sessionStorage#a0.spajs.txs.${CLIENT}`)));
  assert.equal(transaction.state, params.state);
  assert.equal(params.code_challenge, createHash('sha256').update(transaction.code_verifier).digest('base64url'), 'PKCE challenge from crypto.subtle');

  // 2. The browser comes back; the host restarts the page at the callback, its query encoded again.
  const callback = `/auth/callback?code=the-code&state=${encodeURIComponent(params.state)}`;
  page.navigateTo(callback);
  await restarted(first.seen, 1);
  assert.deepEqual([first.seen.reloads, first.seen.addresses.at(-1)], [1, callback]);

  // 3. The callback start finishes the sign-in.
  const second = stubHost({origin: ORIGIN, store, http, ...restartAddress(callback)});
  ({client, page} = await start(second.host));
  assert.equal(g.location.pathname, '/auth/callback');
  await client.handleRedirectCallback();
  const exchange = second.seen.requests.find(r => r.url.endsWith('/oauth/token'));
  assert.equal(exchange.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = Object.fromEntries(new URLSearchParams(exchange.body));
  assert.deepEqual([form.grant_type, form.code, form.code_verifier, form.redirect_uri, form.client_id],
    ['authorization_code', 'the-code', transaction.code_verifier, `${ORIGIN}/auth/callback`, CLIENT]);
  assert.equal((await client.getUser()).sub, 'auth0|jd');
  assert.match(g.document.cookie, new RegExp(`auth0\\.${CLIENT}\\.is\\.authenticated=true`));
  page.flushStorage();
  assert.equal(store.get(`sessionStorage#a0.spajs.txs.${CLIENT}`) ?? '', '', 'the transaction is used up');
  // Auth0Provider's default onRedirectCallback cleans the address.
  g.history.replaceState({}, g.document.title, g.location.pathname);
  assert.deepEqual([g.location.search, second.seen.addresses.at(-1)], ['', '/auth/callback']);
  assert.equal(await client.getTokenSilently(), 'access-1');

  // 4. A later start: signed in from the store, and a refresh uses the refresh token.
  page.flushStorage();
  const third = stubHost({origin: ORIGIN, store, http, path: '/auth/callback'});
  ({client, page} = await start(third.host));
  await client.checkSession();
  assert.equal((await client.getUser())?.name, 'JD');
  assert.equal(await client.getTokenSilently({cacheMode: 'off'}), 'access-2');
  const refresh = Object.fromEntries(new URLSearchParams(third.seen.requests.at(-1).body));
  assert.deepEqual([refresh.grant_type, refresh.refresh_token], ['refresh_token', 'refresh-1']);
  assert.deepEqual(tokenReplies, ['authorization_code', 'refresh_token']);

  // 5. Sign-out goes to Auth0 in the system browser and comes back to the origin.
  await client.logout({logoutParams: {returnTo: g.location.origin}});
  const logout = new URL(third.seen.opened.at(-1));
  assert.equal(logout.origin + logout.pathname, `https://${DOMAIN}/v2/logout`);
  assert.equal(logout.searchParams.get('returnTo'), ORIGIN);
  assert.equal(await client.getUser(), undefined);
  assert.doesNotMatch(g.document.cookie, /is\.authenticated/);
  page.flushStorage();
  assert.deepEqual([...store].filter(([k, v]) => k.includes('@@auth0spajs@@') && v), [], 'no tokens left in the store');
  // As a browser leaves for the sign-out and comes back to returnTo, the page restarts there at once; the browser's
  // return then finds it already there.
  await restarted(third.seen, 1);
  assert.deepEqual([third.seen.reloads, third.seen.addresses.at(-1)], [1, '/']);
});

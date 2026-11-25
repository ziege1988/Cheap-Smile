import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, vapidHeaders, b64urlEncode, b64urlDecode, sendPush } from '../src/push.js';

const enc = new TextEncoder();
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hkdf(salt, ikm, info, bits) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bits));
}

// Browser-Seite nachgebaut: Entschlüsselung nach RFC 8291
async function decrypt(body, uaKeys, auth) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKeys.privateKey, 256));
  const ikm = await hkdf(auth, secret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 256);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 96);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct));
  assert.equal(pt[pt.length - 1], 2);
  return new TextDecoder().decode(pt.slice(0, -1));
}

async function makeSub() {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey)));
  return { ua, auth, sub: { endpoint: 'https://web.push.apple.com/abc123', keys: { p256dh, auth: b64urlEncode(auth) } } };
}

async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64urlEncode(raw), privateKey: jwk.d, subject: 'https://example.github.io/Cheap-Smile/' };
}

test('Nutzlast-Verschlüsselung (aes128gcm) ist entschlüsselbar', async () => {
  const { ua, auth, sub } = await makeSub();
  const body = await encryptPayload(sub, JSON.stringify({ title: 'Hallo €' }));
  assert.equal(JSON.parse(await decrypt(body, ua, auth)).title, 'Hallo €');
});

test('VAPID-JWT ist gültig signiert', async () => {
  const v = await makeVapid();
  const { Authorization } = await vapidHeaders('https://web.push.apple.com/abc', v);
  const m = Authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  const pub = await crypto.subtle.importKey('raw', b64urlDecode(m[4]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(m[3]), enc.encode(`${m[1]}.${m[2]}`));
  assert.ok(ok);
});

test('sendPush meldet abgelaufene Abos', async () => {
  const { sub } = await makeSub();
  const r = await sendPush(sub, { title: 't' }, await makeVapid(), async () => new Response('', { status: 410 }));
  assert.equal(r.gone, true);
});

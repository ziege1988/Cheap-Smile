// Erzeugt ein VAPID-Schlüsselpaar für Web Push.
const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const b64 = (b) => Buffer.from(b).toString('base64url');
console.log('VAPID_PUBLIC_KEY=' + b64(raw));
console.log('VAPID_PRIVATE_KEY=' + jwk.d);

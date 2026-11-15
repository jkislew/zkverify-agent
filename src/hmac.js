import crypto from 'node:crypto';

// The platform signs every task delivery and expects every response signed,
// using the 32-byte HMAC secret issued once at agent registration.
// Header: x-agent-games-signature
//
// The build guide does not state the secret's encoding unambiguously, and
// public post-mortems flag exactly this as a trap. We therefore support
// both encodings and let the operator pin one via HMAC_SECRET_ENCODING:
//   - "utf8" : the secret string's UTF-8 bytes are the HMAC key (default)
//   - "hex"  : the secret string is hex-decoded to raw bytes first
// Verification tries the configured encoding first, then the other one.

export function secretKeys(secret, encoding = 'utf8') {
  const keys = [];
  const push = (buf) => { if (buf && buf.length && !keys.some((k) => k.equals(buf))) keys.push(buf); };
  if (encoding === 'hex' && /^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
    push(Buffer.from(secret, 'hex'));
    push(Buffer.from(secret, 'utf8'));
  } else {
    push(Buffer.from(secret, 'utf8'));
    if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) push(Buffer.from(secret, 'hex'));
  }
  return keys;
}

export function hmacHex(key, rawBody) {
  return crypto.createHmac('sha256', key).update(rawBody).digest('hex');
}

// Verify a signature header against the RAW request body (Buffer or string).
// Accepts a bare hex digest, or a "sha256=<hex>" prefixed value.
export function verifySignature(secret, rawBody, headerValue, encoding = 'utf8') {
  if (!secret || !headerValue) return false;
  const given = String(headerValue).trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const givenBuf = Buffer.from(given, 'hex');
  for (const key of secretKeys(secret, encoding)) {
    const expected = crypto.createHmac('sha256', key).update(rawBody).digest();
    if (expected.length === givenBuf.length && crypto.timingSafeEqual(expected, givenBuf)) return true;
  }
  return false;
}

// Sign a response body (string) with the first configured key encoding.
export function signBody(secret, body, encoding = 'utf8') {
  const [key] = secretKeys(secret, encoding);
  return hmacHex(key, Buffer.from(body, 'utf8'));
}

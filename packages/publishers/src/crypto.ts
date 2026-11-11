import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PublishError } from './errors';
import type { Provider } from './types';

const b64u = (buf: Buffer): string => buf.toString('base64url');

function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new PublishError('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded', { code: 'invalid_encryption_key' });
  }
  return key;
}

/** Generate a fresh base64 key suitable for TOKEN_ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

/** AES-256-GCM. Output: `v1:<iv>:<tag>:<ciphertext>` (each part base64url). */
export function encryptToken(plain: string, keyB64: string): string {
  const key = loadKey(keyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${b64u(iv)}:${b64u(cipher.getAuthTag())}:${b64u(ciphertext)}`;
}

export function decryptToken(enc: string, keyB64: string): string {
  const key = loadKey(keyB64);
  const parts = enc.split(':');
  const [version, ivPart, tagPart, dataPart] = parts;
  if (parts.length !== 4 || version !== 'v1' || !ivPart || !tagPart || dataPart === undefined) {
    throw new PublishError('Malformed encrypted token', { code: 'token_decrypt_failed' });
  }
  try {
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('bad iv/tag length');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new PublishError('Encrypted token failed authentication (wrong key or tampered data)', {
      code: 'token_decrypt_failed',
    });
  }
}

/** PKCE (RFC 7636) verifier + S256 challenge. */
export function createPkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = b64u(randomBytes(32));
  const codeChallenge = b64u(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export interface OAuthStatePayload {
  workspaceId: string;
  provider: Provider;
  nonce: string;
}

export interface SignStateOptions {
  /** Lifetime in seconds (default 600). */
  ttlSec?: number;
  now?: () => Date;
}

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** HMAC-SHA256 signed, expiring OAuth state: `<base64url(json)>.<base64url(sig)>`. */
export function signState(
  payload: { workspaceId: string; provider: Provider; nonce?: string },
  secret: string,
  opts: SignStateOptions = {},
): string {
  if (!secret) throw new PublishError('OAUTH_STATE_SECRET is required', { code: 'invalid_state_secret' });
  const now = opts.now ? opts.now() : new Date();
  const body = {
    w: payload.workspaceId,
    p: payload.provider,
    n: payload.nonce ?? b64u(randomBytes(16)),
    e: Math.floor(now.getTime() / 1000) + (opts.ttlSec ?? 600),
  };
  const encoded = b64u(Buffer.from(JSON.stringify(body), 'utf8'));
  return `${encoded}.${b64u(hmac(encoded, secret))}`;
}

/** Verify signature + expiry. Throws PublishError code `invalid_state` / `state_expired`. */
export function verifyState(state: string, secret: string, opts: { now?: () => Date } = {}): OAuthStatePayload {
  const invalid = (): PublishError => new PublishError('Invalid OAuth state', { code: 'invalid_state' });
  if (!secret || typeof state !== 'string') throw invalid();
  const [encoded, sig, ...rest] = state.split('.');
  if (!encoded || !sig || rest.length > 0) throw invalid();
  const expected = hmac(encoded, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
  let body: { w?: unknown; p?: unknown; n?: unknown; e?: unknown };
  try {
    body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as typeof body;
  } catch {
    throw invalid();
  }
  if (typeof body.w !== 'string' || typeof body.p !== 'string' || typeof body.n !== 'string' || typeof body.e !== 'number') {
    throw invalid();
  }
  const now = opts.now ? opts.now() : new Date();
  if (now.getTime() / 1000 > body.e) throw new PublishError('OAuth state expired', { code: 'state_expired' });
  return { workspaceId: body.w, provider: body.p as Provider, nonce: body.n };
}

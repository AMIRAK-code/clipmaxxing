import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPkce } from './crypto';
import { startConnect } from './oauth';
import { tiktokPublisher } from './providers/tiktok';
import { xPublisher } from './providers/x';

const ctx = { config: { clientId: 'cid', clientSecret: 's', redirectUri: 'http://localhost:3000/api/oauth/tiktok/callback' } };

describe('PKCE encodings', () => {
  it('hex challenge is the hex SHA256 of the verifier', () => {
    const { codeVerifier, codeChallenge } = createPkce('hex');
    expect(codeChallenge).toBe(createHash('sha256').update(codeVerifier).digest('hex'));
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('TikTok (desktop Login Kit) gets a hex S256 challenge, X keeps RFC 7636 base64url', () => {
    const tt = new URL(startConnect(tiktokPublisher, ctx, { workspaceId: 'w', stateSecret: 'k' }).authUrl);
    expect(tt.searchParams.get('code_challenge')).toMatch(/^[0-9a-f]{64}$/);
    expect(tt.searchParams.get('code_challenge_method')).toBe('S256');
    expect(tt.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/oauth/tiktok/callback');

    const x = new URL(startConnect(xPublisher, ctx, { workspaceId: 'w', stateSecret: 'k' }).authUrl);
    const xc = x.searchParams.get('code_challenge')!;
    expect(xc).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(xc).not.toMatch(/^[0-9a-f]{64}$/);
  });
});

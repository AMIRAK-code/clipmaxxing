import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublishError, openAssetSource, getPublisher } from './index';
import { makeMeta, makeRender, testCtx } from './testing/mock-fetch';

describe('asset source guards', () => {
  it('rejects empty and relative render files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'klipz-pub-'));
    try {
      const empty = join(dir, 'empty.mp4');
      writeFileSync(empty, '');
      const ctx = testCtx(globalThis.fetch);
      await expect(openAssetSource(makeRender({ filePath: empty }), ctx)).rejects.toMatchObject({ code: 'asset_unreadable' });
      await expect(openAssetSource(makeRender({ filePath: 'relative/clip.mp4' }), ctx)).rejects.toBeInstanceOf(PublishError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validate flags a relative filePath on every provider', () => {
    for (const p of ['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'linkedin'] as const) {
      const issues = getPublisher(p).validate(makeRender({ filePath: 'clip.mp4' }), makeMeta());
      expect(issues.some((i) => i.code === 'file_path_not_absolute')).toBe(true);
    }
  });
});

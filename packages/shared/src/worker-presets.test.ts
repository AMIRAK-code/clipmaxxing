import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPTION_PRESETS, DEFAULT_CAPTION_STYLE_ID, FALLBACK_FONT, FONT_FILES, SAFE_ZONES } from "./presets";

// The Python fast renderer (apps/worker/klipz_worker/fastrender) draws captions with the same styles.
// It reads this generated copy; regenerate with:  KLIPZ_WRITE_PRESETS=1 npx vitest run packages/shared
const file = path.resolve(__dirname, "../../../apps/worker/klipz_worker/fastrender/presets.json");
const expected = {
  captionPresets: CAPTION_PRESETS,
  safeZones: SAFE_ZONES,
  fontFiles: FONT_FILES,
  fallbackFont: FALLBACK_FONT,
  defaultStyleId: DEFAULT_CAPTION_STYLE_ID,
};

describe("worker presets.json", () => {
  it("matches the TypeScript presets (regenerate when this fails)", () => {
    if (process.env.KLIPZ_WRITE_PRESETS === "1") fs.writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("has a TTF for every caption font", () => {
    for (const files of [...Object.values(FONT_FILES), [FALLBACK_FONT]]) {
      for (const f of files) {
        const ttf = path.resolve(path.dirname(file), "fonts", f.file.replace(/\.woff2$/, ".ttf"));
        expect(fs.existsSync(ttf), ttf).toBe(true);
      }
    }
  });
});

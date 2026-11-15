import { continueRender, delayRender, staticFile } from "remotion";
import { FALLBACK_FONT, FONT_FILES } from "@klipz/shared";
import { useEffect, useState } from "react";

let loading: Promise<void> | null = null;

/** Load all self-hosted caption fonts once (from <public>/fonts, never a CDN). */
export function ensureFonts(timeoutMs = 15000): Promise<void> {
  if (loading) return loading;
  if (typeof document === "undefined" || typeof FontFace === "undefined") {
    loading = Promise.resolve();
    return loading;
  }
  const jobs: Promise<unknown>[] = [];
  // the script fallback answers to every weight, so no caption style gets a synthetic bold of it
  const faces: [string, { file: string; weight: number | string }[]][] = [
    ...Object.entries(FONT_FILES),
    [FALLBACK_FONT.family, [{ file: FALLBACK_FONT.file, weight: "100 900" }]],
  ];
  for (const [family, files] of faces) {
    for (const f of files) {
      const face = new FontFace(family, `url(${staticFile(`fonts/${f.file}`)}) format("woff2")`, {
        weight: String(f.weight),
        style: "normal",
      });
      jobs.push(
        face
          .load()
          .then((loaded) => {
            document.fonts.add(loaded);
          })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn(`[klipz] font ${f.file} failed to load`, err);
          }),
      );
    }
  }
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  loading = Promise.race([Promise.all(jobs).then(() => undefined), timeout]);
  return loading;
}

/** Holds the render until the fonts are ready (delayRender), a no-op in the Player. */
export function useCaptionFonts(): void {
  const [handle] = useState(() => delayRender("Loading caption fonts", { timeoutInMilliseconds: 30000 }));
  // state flip forces a re-render so text measured with fallback fonts is re-fitted
  const [, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureFonts().then(() => {
      if (alive) setReady(true);
      // always release the handle, even if unmounted (e.g. StrictMode), or the render times out
      continueRender(handle);
    });
    return () => {
      alive = false;
    };
  }, [handle]);
}

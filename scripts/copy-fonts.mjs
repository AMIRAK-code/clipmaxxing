// Copies the latin woff2 files from @fontsource/* into apps/web/public/fonts
// using the exact filenames listed in packages/shared/src/presets.ts FONT_FILES.
// Run: node scripts/copy-fonts.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps", "web", "public", "fonts");

// output filename -> [@fontsource package, weight]. Keep in sync with FONT_FILES
// (a unit test in packages/video asserts that they match).
export const FONT_COPY = {
  "montserrat-900.woff2": ["montserrat", 900],
  "poppins-800.woff2": ["poppins", 800],
  "inter-700.woff2": ["inter", 700],
  "archivo-black-400.woff2": ["archivo-black", 400],
  "bangers-400.woff2": ["bangers", 400],
  "anton-400.woff2": ["anton", 400],
  "bebas-neue-400.woff2": ["bebas-neue", 400],
};

export function copyFonts() {
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const [name, [pkg, weight]] of Object.entries(FONT_COPY)) {
    const src = path.join(root, "node_modules", "@fontsource", pkg, "files", `${pkg}-latin-${weight}-normal.woff2`);
    if (!fs.existsSync(src)) throw new Error(`Missing font source: ${src} (is @fontsource/${pkg} installed?)`);
    fs.copyFileSync(src, path.join(outDir, name));
    copied.push(name);
  }
  return copied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const copied = copyFonts();
  console.log(`Copied ${copied.length} fonts to ${outDir}`);
}

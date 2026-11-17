/**
 * Right-to-left text (Persian, Arabic, Urdu, Hebrew) at the granularity the caption layout works in:
 * whole words. Both renderers place every caption word themselves, so they need to agree on the order
 * of the words in a line and on the direction each word is drawn in. This is a word-level reading of
 * the Unicode bidirectional algorithm; apps/worker/klipz_worker/fastrender/bidi.py is a port of it.
 */
export type Dir = "ltr" | "rtl";

/** Blocks whose letters are written right to left (Hebrew, Arabic, Syriac, Thaana, N'Ko ...). */
const RTL_RANGES: [number, number][] = [
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x10800, 0x10fff],
  [0x1e800, 0x1efff],
];
/** Of those, the scripts whose letters join (Arabic and its relatives): letter-spacing would break them. */
const CURSIVE_RANGES: [number, number][] = [
  [0x0600, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
];

const inRanges = (cp: number, ranges: [number, number][]) => ranges.some(([a, b]) => cp >= a && cp <= b);
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

/** Letters of `text` by direction (digits, punctuation and marks have no direction of their own). */
export function strongCounts(text: string): { rtl: number; ltr: number } {
  let rtl = 0;
  let ltr = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    if (inRanges(ch.codePointAt(0)!, RTL_RANGES)) rtl++;
    else ltr++;
  }
  return { rtl, ltr };
}

/** Reading direction of a body of text: right to left when most of its letters are. */
export function baseDirection(texts: Iterable<string>): Dir {
  let rtl = 0;
  let ltr = 0;
  for (const t of texts) {
    const c = strongCounts(t);
    rtl += c.rtl;
    ltr += c.ltr;
  }
  return rtl > ltr ? "rtl" : "ltr";
}

/** A word with a right-to-left letter is right-to-left, else one with any letter is left-to-right. */
export function wordDirection(word: string): Dir | null {
  const c = strongCounts(word);
  return c.rtl > 0 ? "rtl" : c.ltr > 0 ? "ltr" : null;
}

/** True when the text has letters of a joining script (Arabic, Persian, Urdu ...). */
export function hasCursiveScript(text: string): boolean {
  for (const ch of text) if (inRanges(ch.codePointAt(0)!, CURSIVE_RANGES)) return true;
  return false;
}

/**
 * Direction of every word of a line. Words without letters (numbers, punctuation) follow the line,
 * except inside a run of the other direction: after a foreign word when they are a number or when a
 * foreign word follows too ("Windows 10 Pro" stays together inside a Persian sentence).
 */
export function resolveWordDirections(words: string[], base: Dir): Dir[] {
  const own = words.map(wordDirection);
  const other: Dir = base === "rtl" ? "ltr" : "rtl";
  return own.map((d, i) => {
    if (d) return d;
    let prev: Dir | null = null;
    for (let j = i - 1; j >= 0 && !prev; j--) prev = own[j] ?? null;
    if (prev !== other) return base;
    let next: Dir | null = null;
    for (let j = i + 1; j < own.length && !next; j++) next = own[j] ?? null;
    return DIGIT.test(words[i]!) || next === other ? other : base;
  });
}

/**
 * Indexes of a line's words from left to right on screen. In a right-to-left line the words run from
 * the right, but a run of left-to-right words keeps its own order (and the other way round).
 */
export function visualOrder(dirs: Dir[], base: Dir): number[] {
  const order = dirs.map((_, i) => i);
  if (base === "rtl") order.reverse();
  const out: number[] = [];
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && dirs[order[j]!] === dirs[order[i]!]) j++;
    const run = order.slice(i, j);
    if (dirs[order[i]!] !== base) run.reverse();
    out.push(...run);
    i = j;
  }
  return out;
}

/** A line's words as they are drawn, left to right: the index of each word and its direction. */
export function layoutWordOrder(words: string[], base: Dir): { index: number; dir: Dir }[] {
  const dirs = resolveWordDirections(words, base);
  return visualOrder(dirs, base).map((index) => ({ index, dir: dirs[index]! }));
}

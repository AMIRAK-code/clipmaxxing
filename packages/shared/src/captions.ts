import type { CaptionStyle } from "./types";
import type { TimedCaptionWord } from "./timeline";

export interface CaptionPage {
  start: number;
  end: number;
  words: TimedCaptionWord[];
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

/**
 * Group words into on-screen pages of 1–4 words. A page breaks when it is
 * full, when the line would get too long, at sentence ends, and at pauses.
 */
export function paginate(
  words: TimedCaptionWord[],
  opts: Pick<CaptionStyle, "wordsPerPage" | "maxCharsPerLine">,
  maxGapSec = 0.6,
): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let cur: TimedCaptionWord[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    pages.push({ start: cur[0]!.os, end: cur[cur.length - 1]!.oe, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
      const full = cur.length >= opts.wordsPerPage;
      const tooLong = chars > opts.maxCharsPerLine * 2;
      const pause = w.os - prev.oe > maxGapSec;
      if (full || tooLong || pause || SENTENCE_END.test(prev.w)) flush();
    }
    cur.push(w);
  }
  flush();
  // Hold each page until the next one starts (capped) so text doesn't flicker.
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    const next = pages[i + 1];
    const hold = next ? Math.min(next.start, p.end + maxGapSec) : p.end + 0.3;
    p.end = Math.max(p.end, hold);
  }
  return pages;
}

export function pageAt(pages: CaptionPage[], t: number): CaptionPage | null {
  // pages are sorted; binary search
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid]!;
    if (t < p.start) hi = mid - 1;
    else if (t >= p.end) lo = mid + 1;
    else return p;
  }
  return null;
}

/** Index of the word being spoken at t, or the last one already spoken (-1 if none yet). */
export function activeWordIndex(page: CaptionPage, t: number): number {
  let idx = -1;
  for (let i = 0; i < page.words.length; i++) {
    if (t >= page.words[i]!.os) idx = i;
  }
  return idx;
}

/** Split a page into display lines respecting maxCharsPerLine. */
export function layoutLines<T extends { w: string }>(words: T[], maxChars: number): T[][] {
  const lines: T[][] = [];
  let line: T[] = [];
  let len = 0;
  for (const w of words) {
    const add = (line.length ? 1 : 0) + w.w.length;
    if (line.length > 0 && len + add > maxChars) {
      lines.push(line);
      line = [];
      len = 0;
    }
    line.push(w);
    len += (line.length > 1 ? 1 : 0) + w.w.length;
  }
  if (line.length) lines.push(line);
  return lines;
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from had has have he her his i if in is it its me my not of on or our she so than that the their them then there they this to was we were what when which who will with you your just like really very".split(
    " ",
  ),
);

const EMOJI_MAP: Array<[RegExp, string]> = [
  [/^(money|cash|dollars?|rich|paid|profit|revenue|million|billion)$/i, "💰"],
  [/^(fire|hot|crazy|insane|wild)$/i, "🔥"],
  [/^(love|loved|heart)$/i, "❤️"],
  [/^(laugh|funny|hilarious|joke|lol)$/i, "😂"],
  [/^(win|won|winner|success|victory|champion)$/i, "🏆"],
  [/^(idea|think|thought|brain|smart|genius)$/i, "🧠"],
  [/^(secret|hidden|nobody)$/i, "🤫"],
  [/^(shock(ed|ing)?|wow|unbelievable|omg)$/i, "😱"],
  [/^(time|clock|hours?|minutes?|seconds?)$/i, "⏰"],
  [/^(grow(th|ing)?|up|increase|scale)$/i, "📈"],
  [/^(stop|never|wrong|mistake|fail(ed|ure)?)$/i, "🚫"],
  [/^(rocket|launch|fast|speed)$/i, "🚀"],
  [/^(world|global|planet|earth)$/i, "🌍"],
  [/^(phone|call|iphone|app)$/i, "📱"],
  [/^(eat|food|hungry|pizza|burger)$/i, "🍔"],
  [/^(sleep|tired|dream)$/i, "😴"],
  [/^(question|why|how)$/i, "🤔"],
  [/^(strong|power(ful)?|gym|muscle)$/i, "💪"],
];

const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

export function emojiFor(word: string): string | undefined {
  const b = bare(word);
  for (const [re, e] of EMOJI_MAP) if (re.test(b)) return e;
  return undefined;
}

/**
 * Offline keyword emphasis: numbers, ALL-CAPS, long uncommon words. The LLM
 * route replaces this when a model is configured; this keeps captions lively
 * without one.
 */
export function heuristicEmphasis<T extends { w: string }>(words: T[], ratio = 0.14): Set<number> {
  const scored = words.map((w, i) => {
    const b = bare(w.w);
    let s = 0;
    if (!b || STOPWORDS.has(b)) return { i, s: -1 };
    if (/\d/.test(b)) s += 3;
    if (w.w.length > 2 && w.w === w.w.toUpperCase() && /[A-Z]/.test(w.w)) s += 2;
    if (emojiFor(w.w)) s += 2;
    s += Math.min(3, Math.max(0, b.length - 5) * 0.5);
    if (/[!?]$/.test(w.w)) s += 1;
    return { i, s };
  });
  const n = Math.max(1, Math.round(words.length * ratio));
  return new Set(
    scored
      .filter((x) => x.s > 0.9)
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((x) => x.i),
  );
}

/** Apply emphasis + emoji flags from a list of keyword strings (LLM output). */
export function applyKeywords<T extends { w: string; emph?: boolean; emoji?: string }>(
  words: T[],
  keywords: string[],
  withEmoji: boolean,
): T[] {
  const set = new Set(keywords.map(bare).filter(Boolean));
  return words.map((w) => {
    const hit = set.has(bare(w.w));
    return { ...w, emph: hit || undefined, emoji: withEmoji && hit ? emojiFor(w.w) : undefined };
  });
}

/**
 * Replace the text of one word. Timing is untouched. Typing several words
 * splits the slot evenly so every new word still has its own highlight time;
 * clearing the text hides the word.
 */
export function editWordText<T extends { id: string; w: string; s: number; e: number; hidden?: boolean }>(
  words: T[],
  id: string,
  text: string,
): T[] {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return words.flatMap((w) => {
    if (w.id !== id) return [w];
    if (parts.length === 0) return [{ ...w, hidden: true }];
    if (parts.length === 1) return [{ ...w, w: parts[0]!, hidden: undefined }];
    const span = (w.e - w.s) / parts.length;
    return parts.map((p, i) => ({
      ...w,
      id: i === 0 ? w.id : `${w.id}_${i}`,
      w: p,
      s: w.s + span * i,
      e: w.s + span * (i + 1),
      hidden: undefined,
    }));
  });
}

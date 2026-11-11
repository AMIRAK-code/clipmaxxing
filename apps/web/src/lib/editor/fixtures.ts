import { createDefaultEditState, type EditState, type Word } from "@klipz/shared";

const PLAIN = "cat dog sun map pen cup hat bed car bus key box fan jar mug pin rug tub van web".split(" ");

/** A 10 s clip (source 20..30) with one short plain word every 0.5 s (no digits, nothing the emphasis heuristic would pick). */
export function sampleWords(start = 20, end = 30): Word[] {
  const out: Word[] = [];
  for (let t = start, i = 0; t < end - 0.01; t += 0.5, i++) out.push({ w: PLAIN[i % PLAIN.length]!, s: t, e: t + 0.4 });
  return out;
}

export function sampleEdit(start = 20, end = 30): EditState {
  return createDefaultEditState({ start, end, words: sampleWords(start, end), hook: "Hook", styleId: "bold-outline" });
}

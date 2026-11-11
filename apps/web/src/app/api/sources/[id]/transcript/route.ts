import { wordsInRange } from "@/server/clips";
import { notFound, ok, route } from "@/server/http";
import { getSource, getTranscript } from "@/server/repo";

export const dynamic = "force-dynamic";

const num = (v: string | null): number | null => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Transcript of a source video; ?from=&to= (seconds) narrows the words and segments. */
export const GET = route<{ id: string }>((req, { id }) => {
  getSource(id) ?? notFound("Source video not found");
  const t = getTranscript(id) ?? notFound("No transcript yet");
  const q = new URL(req.url).searchParams;
  const from = num(q.get("from"));
  const to = num(q.get("to"));
  const words = t.words ?? [];
  const segments = t.segments ?? [];
  if (from === null && to === null) return ok({ words, segments, language: t.language });
  const lo = from ?? Number.NEGATIVE_INFINITY;
  const hi = to ?? Number.POSITIVE_INFINITY;
  return ok({
    words: wordsInRange(words, lo, hi),
    segments: segments.filter((s) => s.e > lo && s.s < hi),
    language: t.language,
  });
});

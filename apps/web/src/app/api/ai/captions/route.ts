import { body, ok, route } from "@/server/http";
import { CaptionRequestSchema, generateCaptions } from "@/server/social/captions";

export const dynamic = "force-dynamic";

/** -> {generator: 'claude'|'heuristic', model?, note?, captions: {[provider]: {caption, hashtags[], title?}}} */
export const POST = route(async (req) => ok(await generateCaptions(await body(req, CaptionRequestSchema))));

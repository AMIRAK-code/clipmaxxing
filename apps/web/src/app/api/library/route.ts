import { ok, route } from "@/server/http";
import { syncLibrary } from "@/server/library";

export const dynamic = "force-dynamic";

/** Folders and files of the Library (also refreshes the friendly-named links on disk). */
export const GET = route(() => ok(syncLibrary()));

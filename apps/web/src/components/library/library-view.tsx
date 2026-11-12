"use client";

import { Copy, Film, FolderOpen, FolderSearch, Play, Scissors, Share2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Badge, Card } from "@/components/ui/primitives";
import { api, fileUrl, formatBytes, formatDuration } from "@/lib/utils";
import type { LibraryAction, LibraryItem, LibraryOverview, LibraryTarget } from "@/server/library";

/** The desktop shell (WebView2 host) exposes this; a normal browser does not. */
type HostBridge = { postMessage: (msg: unknown) => void };
const hostBridge = (): HostBridge | null => {
  if (typeof window === "undefined") return null;
  return (window as unknown as { chrome?: { webview?: HostBridge } }).chrome?.webview ?? null;
};

export function LibraryView() {
  const [lib, setLib] = useState<LibraryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  const { toast, node } = useToast();

  const load = useCallback(async () => {
    try {
      setLib(await api<LibraryOverview>("/api/library"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the library");
    }
  }, []);

  useEffect(() => {
    setCanShare(hostBridge() !== null);
    void load();
  }, [load]);

  const act = async (action: LibraryAction, target: LibraryTarget, done?: string) => {
    const tag = `${action}:${target.kind}:${target.id}`;
    setBusy(tag);
    try {
      await api("/api/library/action", { method: "POST", json: { action, target } });
      if (done) toast("success", done);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(null);
    }
  };

  const share = (item: LibraryItem) => {
    const host = hostBridge();
    if (!host) return;
    host.postMessage({ type: "share", path: item.path, title: item.title });
  };

  if (error) return <p role="alert" className="m-6 rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{error}</p>;
  if (!lib) return <p className="p-6 text-sm text-muted">Loading…</p>;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-black tracking-tight">Library</h1>
          <p className="text-sm text-muted">Your videos as normal files on this PC, with real names: open them in Explorer, play them, or send them to another app.</p>
        </div>
        <Badge>{formatBytes(lib.totalBytes)} total</Badge>
        {lib.canReveal ? (
          <Button size="sm" variant="secondary" onClick={() => void act("open", { kind: "folder", id: "library" })} data-testid="open-library">
            <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Open Library folder
          </Button>
        ) : null}
      </header>

      <Section
        icon={<Film className="h-4 w-4" aria-hidden />}
        title="Raw videos"
        hint="Everything you uploaded or imported from YouTube, untouched."
        folder={lib.folders.raw}
        canReveal={lib.canReveal}
        onOpenFolder={() => void act("open", { kind: "folder", id: "raw" })}
        empty="No videos yet. Import one on the Projects page."
        items={lib.raw}
        busy={busy}
        canShare={canShare}
        onAct={act}
        onShare={share}
      />

      <Section
        icon={<Scissors className="h-4 w-4" aria-hidden />}
        title="Edited clips"
        hint="The latest finished export of every clip, in a folder per project."
        folder={lib.folders.clips}
        canReveal={lib.canReveal}
        onOpenFolder={() => void act("open", { kind: "folder", id: "clips" })}
        empty="No finished clips yet. Export a clip in the editor, or run AutoClip."
        items={lib.clips}
        busy={busy}
        canShare={canShare}
        onAct={act}
        onShare={share}
      />

      <p className="text-xs text-muted">
        These are links to the files KLIPZ already stores, so they take no extra disk space. Deleting one here does not delete the video in KLIPZ; delete projects in KLIPZ to free space. Copies you make elsewhere are yours to keep.
      </p>
      {node}
    </div>
  );
}

function Section({
  icon, title, hint, folder, canReveal, onOpenFolder, empty, items, busy, canShare, onAct, onShare,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  folder: string;
  canReveal: boolean;
  onOpenFolder: () => void;
  empty: string;
  items: LibraryItem[];
  busy: string | null;
  canShare: boolean;
  onAct: (action: LibraryAction, target: LibraryTarget, done?: string) => Promise<void>;
  onShare: (item: LibraryItem) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <span className="text-accent-2">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">
            {title} <span className="text-sm font-semibold text-muted">· {items.length}</span>
          </h2>
          <p className="text-xs text-muted">{hint}</p>
          <code className="mt-1 block break-all rounded bg-panel-2 px-1.5 py-0.5 text-xs text-fg select-all">{folder}</code>
        </div>
        {canReveal ? (
          <Button size="sm" onClick={onOpenFolder}>
            <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Open in Explorer
          </Button>
        ) : null}
      </Card>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const target: LibraryTarget = { kind: item.kind, id: item.id };
            const thumb = fileUrl(item.thumbKey);
            const name = item.path.split(/[\\/]/).pop() ?? item.title;
            return (
              <li key={`${item.kind}:${item.id}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel p-3" data-library-item={item.kind}>
                <div className={`shrink-0 overflow-hidden rounded-md bg-panel-2 ${item.kind === "clip" ? "h-16 w-9" : "h-12 w-20"}`}>
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold" title={name}>{name}</p>
                  <p className="truncate text-xs text-muted">
                    {[item.project, formatDuration(item.durationSec), formatBytes(item.sizeBytes), item.origin === "youtube" ? "YouTube" : item.origin === "upload" ? "Upload" : null, new Date(item.createdAt).toLocaleDateString()].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {item.kind === "clip" && item.clipId ? (
                    <Link href={`/compose/${item.clipId}`} className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold text-accent-2 hover:bg-panel-2">
                      Post…
                    </Link>
                  ) : null}
                  {canReveal ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void onAct("open", target)} disabled={busy === `open:${item.kind}:${item.id}`} aria-label={`Play ${name}`}>
                        <Play className="h-3.5 w-3.5" aria-hidden /> Play
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void onAct("reveal", target)} disabled={busy === `reveal:${item.kind}:${item.id}`} aria-label={`Show ${name} in Explorer`}>
                        <FolderSearch className="h-3.5 w-3.5" aria-hidden /> Show in Explorer
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void onAct("copy", target, "File copied. Paste it (Ctrl+V) into WhatsApp, Telegram, Discord, an email or a folder.")}
                        disabled={busy === `copy:${item.kind}:${item.id}`}
                        aria-label={`Copy ${name}`}
                      >
                        <Copy className="h-3.5 w-3.5" aria-hidden /> Copy file
                      </Button>
                    </>
                  ) : null}
                  {canShare ? (
                    <Button size="sm" variant="secondary" onClick={() => onShare(item)} aria-label={`Share ${name}`} data-testid="share-file">
                      <Share2 className="h-3.5 w-3.5" aria-hidden /> Share
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

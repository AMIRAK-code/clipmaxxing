import type { EditState } from "@klipz/shared";

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

export interface SaveInfo {
  status: SaveStatus;
  /** human-readable detail for error / conflict */
  message?: string;
  /** seconds until the next automatic retry (error status) */
  retryInMs?: number;
}

/** Minimal Response shape so tests can pass a fake. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; keepalive?: boolean }) => Promise<FetchResponse>;

export interface AutosaveOptions {
  clipId: string;
  /** edit_version the server currently has */
  version: number;
  /** the edit the server currently has (null/undefined = nothing persisted yet) */
  saved?: EditState | null;
  fetchImpl?: FetchLike;
  debounceMs?: number;
  /** retry delays for transient failures; the last value repeats */
  backoffMs?: number[];
  onStatus?: (info: SaveInfo) => void;
  /** 409: the server has a newer edit. Called with it so the editor can reload. */
  onConflict?: (server: { edit_state: EditState | null; edit_version: number }) => void;
  onSaved?: (version: number) => void;
}

const KEEPALIVE_LIMIT = 60_000; // browsers cap keepalive bodies at 64 KB

/**
 * Debounced, serialised, never-lossy saver for one clip's EditState.
 * - at most one request in flight; edits made meanwhile trigger one more save
 * - transient failures (network, 5xx) retry with backoff and keep the latest edit
 * - 409 reloads the server version through onConflict and stops retrying
 */
export class Autosaver {
  private readonly clipId: string;
  private version: number;
  private savedEdit: EditState | null;
  private latest: EditState | null = null;
  private status: SaveStatus = "saved";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private disposed = false;
  private readonly fetchImpl: FetchLike;
  private readonly debounceMs: number;
  private readonly backoffMs: number[];
  private readonly opts: AutosaveOptions;

  constructor(opts: AutosaveOptions) {
    this.opts = opts;
    this.clipId = opts.clipId;
    this.version = opts.version;
    this.savedEdit = opts.saved ?? null;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as Promise<FetchResponse>);
    this.debounceMs = opts.debounceMs ?? 800;
    this.backoffMs = opts.backoffMs ?? [1000, 2000, 4000, 8000, 15000];
  }

  get currentStatus(): SaveStatus {
    return this.status;
  }
  get currentVersion(): number {
    return this.version;
  }

  private emit(status: SaveStatus, extra: Omit<SaveInfo, "status"> = {}): void {
    this.status = status;
    if (!this.disposed) this.opts.onStatus?.({ status, ...extra });
  }

  /** The editor's edit changed. */
  change(edit: EditState): void {
    if (this.disposed) return;
    this.latest = edit;
    if (edit === this.savedEdit) {
      // undo back to the persisted state
      if (this.status === "dirty") {
        this.clearTimer();
        this.emit("saved");
      }
      return;
    }
    if (this.status === "saving") return; // the in-flight save re-checks when it finishes
    this.failures = 0;
    this.emit("dirty");
    this.schedule(this.debounceMs);
  }

  /** The editor adopted an edit that is already persisted (initial load, conflict reload). */
  adopt(edit: EditState, version: number): void {
    this.latest = edit;
    this.savedEdit = edit;
    this.version = version;
    this.failures = 0;
    this.clearTimer();
  }

  /** Save now (Ctrl+S, before export). Resolves true when everything is persisted. */
  async flush(): Promise<boolean> {
    this.clearTimer();
    for (let i = 0; i < 4; i++) {
      if (this.inflight) await this.inflight;
      if (!this.needsSave()) return this.status === "saved" || this.status === "conflict";
      this.failures = 0;
      await this.save();
      if (this.status === "error" || this.status === "conflict") return false;
    }
    return !this.needsSave();
  }

  /**
   * Page is going away: fire the save with keepalive so the browser finishes it.
   * When a save is already in flight the version we hold is about to be stale (that save bumps it),
   * so the latest edit is sent without expected_version: it is the newest state, and the in-flight
   * request (sent earlier) lands first. Never skipped, so an edit made during a save is not lost.
   */
  flushOnHide(): void {
    if (this.disposed || !this.needsSave()) return;
    const edit = this.latest!;
    const payload: { edit_state: EditState; expected_version?: number } = { edit_state: edit };
    if (!this.inflight) payload.expected_version = this.version;
    const body = JSON.stringify(payload);
    this.clearTimer();
    void this.fetchImpl(`/api/clips/${this.clipId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
      keepalive: body.length < KEEPALIVE_LIMIT,
    }).catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private needsSave(): boolean {
    return this.latest !== null && this.latest !== this.savedEdit;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, ms);
  }

  private save(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!this.needsSave()) {
      if (this.status !== "saved" && this.status !== "conflict") this.emit("saved");
      return Promise.resolve();
    }
    const p = this.doSave().finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async doSave(): Promise<void> {
    const sent = this.latest!;
    this.emit("saving");
    let res: FetchResponse;
    try {
      res = await this.fetchImpl(`/api/clips/${this.clipId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edit_state: sent, expected_version: this.version }),
      });
    } catch (e) {
      this.retryLater(e instanceof Error ? e.message : "Network error");
      return;
    }

    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { clip?: { edit_version?: number } } | null;
      const v = data?.clip?.edit_version;
      this.version = typeof v === "number" ? v : this.version + 1;
      this.savedEdit = sent;
      this.failures = 0;
      this.opts.onSaved?.(this.version);
      if (this.latest !== sent) {
        this.emit("dirty");
        this.schedule(this.debounceMs);
      } else this.emit("saved");
      return;
    }

    if (res.status === 409) {
      await this.handleConflict();
      return;
    }
    const msg = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Save failed (${res.status})`;
    if (res.status >= 500 || res.status === 408 || res.status === 429) this.retryLater(msg);
    else this.emit("error", { message: msg }); // 4xx will not fix itself; the next edit tries again
  }

  private async handleConflict(): Promise<void> {
    try {
      const res = await this.fetchImpl(`/api/clips/${this.clipId}`, { method: "GET", headers: {} });
      if (!res.ok) throw new Error(`reload failed (${res.status})`);
      const data = (await res.json()) as { clip: { edit_state: EditState | null; edit_version: number } };
      const { edit_state, edit_version } = data.clip;
      if (edit_state) {
        this.adopt(edit_state, edit_version);
        this.opts.onConflict?.({ edit_state, edit_version });
      } else {
        // the server has no edit yet: keep ours and just take the new version
        this.version = edit_version;
        this.schedule(0);
        return;
      }
      this.emit("conflict", { message: "This clip was changed elsewhere. Loaded the newer version." });
    } catch (e) {
      this.retryLater(e instanceof Error ? e.message : "Conflict reload failed");
    }
  }

  private retryLater(message: string): void {
    const delay = this.backoffMs[Math.min(this.failures, this.backoffMs.length - 1)] ?? 15000;
    this.failures += 1;
    this.emit("error", { message, retryInMs: delay });
    this.schedule(delay);
  }
}

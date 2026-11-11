/**
 * Frame fan-out for the editor. The Remotion player emits a frame event on
 * every frame; React state per frame would re-render the whole editor, so
 * consumers subscribe here and write straight to the DOM. Notifications are
 * coalesced to at most one per animation frame.
 */
export type FrameListener = (frame: number) => void;

export class Playhead {
  private frame = 0;
  private readonly listeners = new Set<FrameListener>();
  private raf: number | null = null;
  private readonly schedule: (cb: () => void) => number;
  private readonly cancel: (id: number) => void;

  constructor(
    schedule: (cb: () => void) => number = (cb) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)),
    cancel: (id: number) => void = (id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id)),
  ) {
    this.schedule = schedule;
    this.cancel = cancel;
  }

  get current(): number {
    return this.frame;
  }

  /** Record the new frame; listeners hear about it on the next animation frame. */
  set(frame: number): void {
    this.frame = frame;
    if (this.raf !== null) return;
    this.raf = this.schedule(() => {
      this.raf = null;
      for (const l of this.listeners) l(this.frame);
    });
  }

  /** Subscribe; the listener is called once immediately with the current frame. */
  subscribe(l: FrameListener): () => void {
    this.listeners.add(l);
    l(this.frame);
    return () => this.listeners.delete(l);
  }

  dispose(): void {
    if (this.raf !== null) this.cancel(this.raf);
    this.raf = null;
    this.listeners.clear();
  }
}

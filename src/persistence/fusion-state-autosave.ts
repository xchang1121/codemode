import { FusionLearner } from "../learning/fusion-learner.js";
import { FusionStateStore } from "./fusion-state-store.js";

export interface FusionStateAutosaveOptions {
  readonly debounceMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** Coalesces observations and serializes state writes without dropping updates. */
export class FusionStateAutosave {
  private readonly store: FusionStateStore;
  private readonly learner: FusionLearner;
  private readonly debounceMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private dirty = false;
  private closed = false;

  constructor(
    store: FusionStateStore,
    learner: FusionLearner,
    options: FusionStateAutosaveOptions = {},
  ) {
    this.store = store;
    this.learner = learner;
    this.debounceMs = nonNegativeInteger(options.debounceMs ?? 500, 500);
    this.onError = options.onError;
  }

  schedule(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error) => this.onError?.(error));
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.flushing) {
      await this.flushing;
      if (this.dirty) await this.flush();
      return;
    }
    if (!this.dirty) return;
    this.flushing = this.writeUntilClean();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
    if (this.dirty) await this.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }

  private async writeUntilClean(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.store.save(this.learner);
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    }
  }
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

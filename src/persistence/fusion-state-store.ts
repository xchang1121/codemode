import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { FusionLearner } from "../learning/fusion-learner.js";
import type { FusionLearnerSnapshot } from "../learning/types.js";

const STATE_FORMAT = "codemode-fusion-state";
const STATE_VERSION = 1;
const DEFAULT_MAX_STATE_BYTES = 16 * 1024 * 1024;

export interface FusionStateStoreOptions {
  readonly maxStateBytes?: number;
}

export type FusionStateLoadResult =
  | { readonly status: "missing" }
  | { readonly status: "loaded"; readonly savedAt: string }
  | { readonly status: "invalid"; readonly reason: string };

interface StoredFusionState {
  readonly format: typeof STATE_FORMAT;
  readonly version: typeof STATE_VERSION;
  readonly savedAt: string;
  readonly learner: FusionLearnerSnapshot;
}

/** Atomic JSON persistence for compact, value-minimized learner snapshots. */
export class FusionStateStore {
  readonly filePath: string;
  private readonly maxStateBytes: number;

  constructor(filePath: string, options: FusionStateStoreOptions = {}) {
    this.filePath = resolve(filePath);
    this.maxStateBytes = positiveInteger(
      options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES,
      DEFAULT_MAX_STATE_BYTES,
    );
  }

  async load(learner: FusionLearner): Promise<FusionStateLoadResult> {
    let details;
    try {
      details = await stat(this.filePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { status: "missing" };
      throw error;
    }
    if (!details.isFile()) return { status: "invalid", reason: "State path is not a file" };
    if (details.size > this.maxStateBytes) {
      return {
        status: "invalid",
        reason: `State file exceeds ${this.maxStateBytes} byte limit`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { status: "invalid", reason: "State file is not valid JSON" };
      }
      throw error;
    }
    const state = asRecord(parsed);
    if (
      state?.format !== STATE_FORMAT ||
      state.version !== STATE_VERSION ||
      typeof state.savedAt !== "string"
    ) {
      return { status: "invalid", reason: "Unsupported state envelope" };
    }
    if (!learner.restore(state.learner)) {
      return { status: "invalid", reason: "Invalid learner snapshot" };
    }
    return { status: "loaded", savedAt: state.savedAt };
  }

  async save(learner: FusionLearner): Promise<void> {
    const state: StoredFusionState = {
      format: STATE_FORMAT,
      version: STATE_VERSION,
      savedAt: new Date().toISOString(),
      learner: learner.snapshot(),
    };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const size = Buffer.byteLength(serialized, "utf8");
    if (size > this.maxStateBytes) {
      throw new Error(`Learner state is ${size} bytes; limit is ${this.maxStateBytes}`);
    }

    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = resolve(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryExists = false;
    try {
      await writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      temporaryExists = true;
      await rename(temporaryPath, this.filePath);
      temporaryExists = false;
    } finally {
      if (temporaryExists) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function errorCode(error: unknown): string | undefined {
  const code = asRecord(error)?.code;
  return typeof code === "string" ? code : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

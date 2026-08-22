import { CODE_MODE_META_KEY } from "../code-mode/contract.js";
import { stableStringify } from "../core/stable.js";
import { FusionLearner } from "../learning/fusion-learner.js";
import type { FusionPath, ToolObservation } from "../learning/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolInvocationTrace, ToolResult } from "../tools/types.js";
import {
  fusionHintText,
  renderFusionHints,
  type RenderedFusionHint,
} from "./fusion-hints.js";

export type HintDelivery = "content" | "meta" | "both" | "off";

/** Narrow port consumed by Code Mode orchestration; no learning internals leak through it. */
export interface FusionAdvisorPort {
  commonHints(task: string, limit: number): readonly RenderedFusionHint[];
  suggestHints(sessionId: string, task: string, limit: number): readonly RenderedFusionHint[];
  activeHints(sessionId: string): readonly RenderedFusionHint[];
  attachHints(result: ToolResult, sessionId: string): ToolResult;
  onHintsChanged(listener: () => void): () => void;
  close(): void;
}

export interface FusionAdvisorOptions {
  readonly registry: ToolRegistry;
  readonly learner?: FusionLearner;
  readonly hintDelivery?: HintDelivery;
  readonly maxActiveHints?: number;
  /** Runs after authoritative observations update the learner. */
  readonly onLearnerChanged?: (learner: FusionLearner) => void;
  readonly batchFlushMs?: number;
}

interface BufferedBatch {
  readonly expected: number;
  readonly traces: Map<number, ToolInvocationTrace>;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Cohesive learning adapter: observes authoritative registry traces, preserves
 * sibling batches, queries PPM/trie paths, renders hints, and emits only a
 * semantic "hints changed" event to the MCP side.
 */
export class FusionAdvisor implements FusionAdvisorPort {
  readonly learner: FusionLearner;
  private readonly registry: ToolRegistry;
  private readonly hintDelivery: HintDelivery;
  private readonly maxActiveHints: number;
  private readonly onLearnerChanged: ((learner: FusionLearner) => void) | undefined;
  private readonly batchFlushMs: number;
  private readonly batches = new Map<string, BufferedBatch>();
  private readonly listeners = new Set<() => void>();
  private readonly removeInvocationListener: () => void;
  private lastHintSignature: string;
  private closed = false;

  constructor(options: FusionAdvisorOptions) {
    this.registry = options.registry;
    this.learner = options.learner ?? new FusionLearner();
    this.hintDelivery = options.hintDelivery ?? "both";
    this.maxActiveHints = Math.max(0, Math.floor(options.maxActiveHints ?? 2));
    this.onLearnerChanged = options.onLearnerChanged;
    this.batchFlushMs = positiveInteger(options.batchFlushMs, 1_000);
    this.lastHintSignature = this.currentHintSignature();
    this.removeInvocationListener = this.registry.onInvocation((trace) => this.observeTrace(trace));
  }

  commonHints(task: string, limit: number): readonly RenderedFusionHint[] {
    const bounded = positiveInteger(limit, 1);
    return this.filterHints(
      this.learner.commonPaths(bounded, this.registry.schemaHashes()),
      task,
    ).slice(0, bounded);
  }

  suggestHints(
    sessionId: string,
    task: string,
    limit: number,
  ): readonly RenderedFusionHint[] {
    const bounded = positiveInteger(limit, 1);
    const schemaHashes = this.registry.schemaHashes();
    const sessionPaths = this.learner.predictPaths(sessionId, schemaHashes);
    const paths = sessionPaths.length
      ? sessionPaths
      : this.learner.commonPaths(bounded * 2, schemaHashes);
    return this.filterHints(paths, task).slice(0, bounded);
  }

  activeHints(sessionId: string): readonly RenderedFusionHint[] {
    if (this.hintDelivery === "off" || this.maxActiveHints === 0) return [];
    return renderFusionHints(
      this.learner.predictPaths(sessionId, this.registry.schemaHashes()),
      this.registry,
      this.maxActiveHints,
    );
  }

  attachHints(result: ToolResult, sessionId: string): ToolResult {
    const hints = this.activeHints(sessionId);
    if (!hints.length || this.hintDelivery === "off") return result;
    const content = [...result.content];
    if (this.hintDelivery === "content" || this.hintDelivery === "both") {
      content.push({
        type: "text",
        text: fusionHintText(hints),
        annotations: { audience: ["assistant"], priority: 0.25 },
      });
    }
    return {
      ...result,
      content,
      ...(this.hintDelivery === "meta" || this.hintDelivery === "both"
        ? {
            _meta: {
              ...result._meta,
              [CODE_MODE_META_KEY]: { fusionHints: hints },
            },
          }
        : {}),
    };
  }

  onHintsChanged(listener: () => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.removeInvocationListener();
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
    this.listeners.clear();
  }

  private observeTrace(trace: ToolInvocationTrace): void {
    if (this.closed) return;
    const batchId = trace.context.batchId;
    const batchSize = trace.context.batchSize;
    const batchIndex = trace.context.batchIndex;
    if (!batchId || batchSize === undefined || batchIndex === undefined || batchSize <= 1) {
      this.observeTraces([trace]);
      return;
    }
    let batch = this.batches.get(batchId);
    if (!batch) {
      const timer = setTimeout(() => this.flushBatch(batchId), this.batchFlushMs);
      timer.unref?.();
      batch = { expected: batchSize, traces: new Map(), timer };
      this.batches.set(batchId, batch);
    }
    batch.traces.set(batchIndex, trace);
    if (batch.traces.size >= batch.expected) this.flushBatch(batchId);
  }

  private flushBatch(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(batchId);
    this.observeTraces(
      [...batch.traces.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, trace]) => trace),
    );
  }

  private observeTraces(traces: readonly ToolInvocationTrace[]): void {
    const observations = traces.map(traceObservation);
    if (observations.length > 1) this.learner.observeBatch(observations);
    else if (observations[0]) this.learner.observe(observations[0]);
    try {
      this.onLearnerChanged?.(this.learner);
    } catch {
      // Persistence and telemetry are observers, never part of tool behavior.
    }
    this.notifyHintChanges();
  }

  private notifyHintChanges(): void {
    const signature = this.currentHintSignature();
    if (signature === this.lastHintSignature) return;
    this.lastHintSignature = signature;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Notification listeners cannot change authoritative learning state.
      }
    }
  }

  private currentHintSignature(): string {
    return stableStringify(
      this.learner.commonPaths(8, this.registry.schemaHashes()).map((path) => ({
        tools: path.tools,
        patternIds: path.steps.map((step) => step.patternId),
        probability: Math.round(path.probability * 100),
        dataflowEdges: path.dataflowEdges,
      })),
    );
  }

  private filterHints(
    paths: readonly FusionPath[],
    task: string,
  ): readonly RenderedFusionHint[] {
    const hints = renderFusionHints(paths, this.registry, paths.length);
    const terms = task.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
    if (!terms.length) return hints;
    const matched = hints.filter((hint) => {
      const text = `${hint.summary} ${hint.code}`.toLowerCase();
      return terms.some((term) => text.includes(term));
    });
    return matched.length ? matched : hints;
  }
}

function traceObservation(trace: ToolInvocationTrace): ToolObservation {
  return {
    sessionId: trace.context.sessionId,
    ...(trace.context.batchId ? { turnId: trace.context.batchId } : {}),
    ...(trace.context.callId ? { callId: trace.context.callId } : {}),
    tool: trace.tool.id,
    schemaHash: trace.tool.schemaHash,
    input: trace.args,
    ...(trace.result?.structuredContent !== undefined
      ? { output: trace.result.structuredContent }
      : {}),
    outcome: trace.error || trace.result?.isError ? "error" : "success",
    durationMs: trace.durationMs,
    timestampMs: trace.startedAtMs,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

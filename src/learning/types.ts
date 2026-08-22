import type { PpmCountTrieRow } from "./ppm-count-trie.js";

export type ToolOutcome = "success" | "error";

export interface ToolObservation {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly callId?: string;
  readonly tool: string;
  /** Stable hash of the tool input/output contract, when known. */
  readonly schemaHash?: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Only authoritative structured output should be supplied here. */
  readonly output?: unknown;
  readonly outcome: ToolOutcome;
  readonly durationMs?: number;
  readonly timestampMs?: number;
}

export interface ToolEvent extends ToolObservation {
  readonly sequence: number;
  readonly batchId?: string;
  readonly batchIndex?: number;
  readonly batchSize?: number;
}

export type ValuePath = ReadonlyArray<string | number>;

export interface BindingSource {
  readonly relativeEvent: number;
  readonly field: "input" | "output";
  readonly path: ValuePath;
}

export type ValueBinding =
  | {
      readonly type: "event";
      readonly relativeEvent: number;
      readonly field: "input" | "output";
      readonly path: ValuePath;
    }
  | {
      readonly type: "constant";
      readonly value: unknown;
    }
  | {
      readonly type: "template";
      readonly source: ValueBinding;
      readonly prefix: string;
      readonly suffix: string;
    }
  | {
      readonly type: "transform";
      readonly operation: "dirname" | "basename" | "normalize_path";
      readonly source: ValueBinding;
    }
  | {
      readonly type: "join";
      readonly operation: "join_path";
      readonly left: ValueBinding;
      readonly right: ValueBinding;
    };

export interface LearnedBindingSet {
  readonly bindings: Readonly<Record<string, ValueBinding>>;
  readonly missing: readonly ValuePath[];
  readonly replayProbability: number;
}

export interface LearnedToolPattern {
  readonly id: string;
  readonly context: readonly string[];
  readonly contextTools: readonly string[];
  readonly targetTool: string;
  readonly targetSchemaHash?: string;
  readonly bindings: Readonly<Record<string, ValueBinding>>;
  readonly missing: readonly ValuePath[];
  readonly occurrences: number;
  readonly replayProbability: number;
  readonly averageDurationMs: number;
  readonly lastSeenSequence: number;
}

export interface FusionDependency {
  readonly targetPath: ValuePath;
  readonly sources: readonly BindingSource[];
}

export interface FusionCandidate {
  readonly patternId: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly missing: readonly ValuePath[];
  readonly dependencies: readonly FusionDependency[];
  readonly contextTools: readonly string[];
  readonly probability: number;
  readonly ppmProbability: number;
  readonly ppmOrder: number;
  readonly bindingReplayProbability: number;
  readonly occurrences: number;
  readonly expectedDurationMs: number;
  readonly score: number;
}

export interface FusionPathStep {
  readonly patternId: string;
  readonly tool: string;
  readonly bindings: Readonly<Record<string, ValueBinding>>;
  readonly missing: readonly ValuePath[];
  readonly dependencies: readonly FusionDependency[];
  readonly probability: number;
}

export interface FusionPath {
  readonly contextTools: readonly string[];
  readonly steps: readonly FusionPathStep[];
  readonly tools: readonly string[];
  readonly probability: number;
  readonly score: number;
  readonly dataflowEdges: number;
}

export interface FusionLearnerSnapshot {
  readonly version: 1;
  readonly sequence: number;
  readonly ppm: readonly PpmCountTrieRow[];
  readonly patterns: readonly LearnedToolPattern[];
}

import { stableHash, stableStringify } from "../core/stable.js";
import {
  applyBindingsPartial,
  bindingEvidenceHasOutputDependency,
  bindingDependencies,
  captureBindingEvidence,
  inferStableBindingsFromEvidence,
  type BindingEvidenceCapture,
} from "./bindings.js";
import { PpmCountTrie } from "./ppm-count-trie.js";
import { SuffixPatternTrie } from "./suffix-pattern-trie.js";
import type {
  BindingObservationEvidence,
  FusionCandidate,
  FusionLearnerSnapshot,
  FusionPatternPoolSnapshot,
  FusionPath,
  FusionPathStep,
  LearnedToolPattern,
  ToolEvent,
  ToolObservation,
  ValueBinding,
} from "./types.js";

export interface FusionLearnerSettings {
  readonly maxOrder: number;
  readonly minimumOccurrences: number;
  readonly minimumBindingReplayProbability: number;
  readonly minimumConstantSupport: number;
  readonly decayHalfLifeEvents: number;
  readonly maxPatterns: number;
  readonly maxSamplesPerPool: number;
  readonly maxSessionEvents: number;
  readonly maxSuggestions: number;
  readonly beamWidthPerTool: number;
  readonly maxPathDepth: number;
  /** Maximum structural candidates retained per target-input leaf. */
  readonly maxEvidenceCandidatesPerPath: number;
  /** Serialized byte budget for value-minimized evidence pools. */
  readonly maxPersistedEvidenceBytes: number;
  /** Persist value-minimized pre-pattern evidence across process restarts. */
  readonly persistBindingEvidence: boolean;
  /** Learn data-flow subsequences that skip unrelated intervening calls. */
  readonly learnCausalSubsequences: boolean;
  /** Use a second suffix trie while expanding learned multi-step paths. */
  readonly indexToolSuffixes: boolean;
}

export const FUSION_LEARNER_DEFAULTS: FusionLearnerSettings = {
  maxOrder: 4,
  minimumOccurrences: 2,
  minimumBindingReplayProbability: 0.75,
  minimumConstantSupport: 4,
  decayHalfLifeEvents: 2_048,
  maxPatterns: 4_096,
  maxSamplesPerPool: 32,
  maxSessionEvents: 64,
  maxSuggestions: 8,
  beamWidthPerTool: 2,
  maxPathDepth: 4,
  maxEvidenceCandidatesPerPath: 64,
  maxPersistedEvidenceBytes: 4 * 1024 * 1024,
  persistBindingEvidence: true,
  learnCausalSubsequences: true,
  indexToolSuffixes: true,
};

interface PatternPool {
  readonly key: string;
  readonly context: readonly string[];
  readonly contextTools: readonly string[];
  readonly targetTool: string;
  readonly targetSchemaHash?: string;
  readonly observations: BindingObservationEvidence[];
  patternId?: string;
}

interface LearningContext {
  readonly events: readonly ToolEvent[];
  readonly projected: boolean;
}

interface PathFrontier {
  readonly contextTools: readonly string[];
  readonly steps: readonly FusionPathStep[];
  readonly tools: readonly string[];
  readonly probability: number;
  readonly score: number;
  readonly dataflowEdges: number;
  readonly visited: ReadonlySet<string>;
}

/**
 * Online tool-path learner.
 *
 * The PPM trie estimates which tool follows the current suffix. The pattern
 * trie selects concrete contexts, while binding replay verifies that later
 * arguments can be reconstructed from earlier structured inputs or outputs.
 */
export class FusionLearner {
  private readonly settings: FusionLearnerSettings;
  private readonly pools = new Map<string, PatternPool>();
  private readonly patterns = new Map<string, LearnedToolPattern>();
  private readonly sessions = new Map<string, ToolEvent[]>();
  private ppm: PpmCountTrie;
  private patternTrie = new SuffixPatternTrie();
  private toolPatternTrie = new SuffixPatternTrie();
  private indexDirty = false;
  private sequence = 0;

  constructor(settings: Partial<FusionLearnerSettings> = {}) {
    this.settings = normalizeSettings(settings);
    this.ppm = new PpmCountTrie(this.settings.maxOrder);
  }

  observe(observation: ToolObservation): ToolEvent {
    return this.observeBatch([observation])[0]!;
  }

  /**
   * Observe independent calls emitted in one provider batch. Siblings are
   * sorted canonically and never used as causal context for one another.
   */
  observeBatch(observations: readonly ToolObservation[]): readonly ToolEvent[] {
    const first = observations[0];
    if (!first) return [];
    if (observations.some((item) => item.sessionId !== first.sessionId)) {
      throw new Error("A tool batch must belong to one session");
    }
    const batchId =
      observations.length > 1
        ? first.turnId ?? first.callId ?? `batch-${this.sequence + 1}`
        : undefined;
    const ordered = observations
      .map((observation, originalIndex) => ({
        observation,
        originalIndex,
        key: stableStringify({
          tool: observation.tool,
          schemaHash: observation.schemaHash,
          input: observation.input,
          outcome: observation.outcome,
        }),
      }))
      .sort((left, right) => left.key.localeCompare(right.key) || left.originalIndex - right.originalIndex);
    const events = ordered.map(({ observation }, index) =>
      normalizeEvent(observation, ++this.sequence, batchId, index, ordered.length),
    );
    const history = this.sessions.get(first.sessionId) ?? [];
    const prior = [...history];
    const tokens = prior.map(eventToken);
    for (const event of events) {
      this.ppm.observe(tokens, event.tool, event.sequence);
      this.learn(prior, event);
    }
    history.push(...events);
    if (history.length > this.settings.maxSessionEvents) {
      history.splice(0, history.length - this.settings.maxSessionEvents);
    }
    this.sessions.set(first.sessionId, history);
    this.ppm.trim(this.settings.maxPatterns);
    this.trimPatterns();
    return events;
  }

  finishSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  recent(sessionId: string): readonly ToolEvent[] {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  predict(
    sessionId: string,
    schemaHashes: Readonly<Record<string, string>> = {},
  ): readonly FusionCandidate[] {
    const history = this.sessions.get(sessionId) ?? [];
    if (!history.length) return [];
    this.ensureIndex();
    const tokens = history.map(eventToken);
    const candidates: FusionCandidate[] = [];
    for (const patternId of this.patternTrie.matching(tokens)) {
      const pattern = this.patterns.get(patternId);
      if (!pattern || !matchesSuffix(tokens, pattern.context)) continue;
      if (
        pattern.targetSchemaHash &&
        schemaHashes[pattern.targetTool] !== undefined &&
        schemaHashes[pattern.targetTool] !== pattern.targetSchemaHash
      ) {
        continue;
      }
      const context = history.slice(-pattern.context.length);
      const applied = applyBindingsPartial(pattern.bindings, context, pattern.missing);
      const ppmEstimate = this.ppm.estimate(
        tokens,
        pattern.targetTool,
        this.sequence,
        this.settings.decayHalfLifeEvents,
      );
      if (!ppmEstimate) continue;
      const probability = clampProbability(
        ppmEstimate.probability * pattern.replayProbability,
      );
      const score = probability * Math.max(1, pattern.averageDurationMs);
      candidates.push({
        patternId: pattern.id,
        tool: pattern.targetTool,
        input: applied.input,
        missing: applied.missing,
        dependencies: bindingDependencies(pattern.bindings),
        contextTools: pattern.contextTools,
        probability,
        ppmProbability: ppmEstimate.probability,
        ppmOrder: ppmEstimate.order,
        bindingReplayProbability: pattern.replayProbability,
        occurrences: pattern.occurrences,
        expectedDurationMs: pattern.averageDurationMs,
        score,
      });
    }
    return perToolBeam(
      deduplicateCandidates(candidates).sort(
        (left, right) =>
          right.score - left.score ||
          right.probability - left.probability ||
          right.occurrences - left.occurrences ||
          left.patternId.localeCompare(right.patternId),
      ),
      this.settings.beamWidthPerTool,
    ).slice(0, this.settings.maxSuggestions);
  }

  /** Build likely multi-step paths from the current session suffix. */
  predictPaths(
    sessionId: string,
    schemaHashes: Readonly<Record<string, string>> = {},
  ): readonly FusionPath[] {
    const initial = this.predict(sessionId, schemaHashes);
    const frontiers: PathFrontier[] = initial.map((candidate) => {
      const pattern = this.patterns.get(candidate.patternId);
      const step = pattern
        ? patternToStep(pattern, candidate.probability)
        : candidateToStep(candidate);
      const contextTools = fusionContextTools(candidate.contextTools, step);
      return {
        contextTools,
        steps: [step],
        tools: [...contextTools, candidate.tool],
        probability: candidate.probability,
        score: candidate.score,
        dataflowEdges: outputDependencyCount(step),
        visited: new Set([candidate.patternId]),
      };
    }).filter((item) => item.dataflowEdges > 0);
    return this.expandPaths(frontiers, schemaHashes);
  }

  /** Build reusable paths from all retained patterns, independent of a session. */
  commonPaths(
    limit = this.settings.maxSuggestions,
    schemaHashes: Readonly<Record<string, string>> = {},
  ): readonly FusionPath[] {
    const starts = [...this.patterns.values()]
      .filter((pattern) => matchesCurrentSchema(pattern, schemaHashes))
      .sort(comparePatterns)
      .slice(0, Math.max(limit * 4, limit))
      .map((pattern): PathFrontier => {
        const probability = patternReliability(pattern);
        const step = patternToStep(pattern, probability);
        const contextTools = fusionContextTools(pattern.contextTools, step);
        return {
          contextTools,
          steps: [step],
          tools: [...contextTools, pattern.targetTool],
          probability,
          score: probability * Math.max(1, pattern.averageDurationMs),
          dataflowEdges: outputDependencyCount(step),
          visited: new Set([pattern.id]),
        };
      })
      .filter((item) => item.dataflowEdges > 0);
    return this.expandPaths(starts, schemaHashes).slice(0, Math.max(0, Math.floor(limit)));
  }

  learnedPatterns(): readonly LearnedToolPattern[] {
    return [...this.patterns.values()].sort(comparePatterns).map(clonePattern);
  }

  snapshot(): FusionLearnerSnapshot {
    return {
      version: 2,
      sequence: this.sequence,
      ppm: this.ppm.snapshot(this.settings.maxPatterns),
      patterns: this.learnedPatterns(),
      pools: this.settings.persistBindingEvidence ? this.snapshotPools() : [],
    };
  }

  restore(value: unknown): boolean {
    if (!isSnapshot(value)) return false;
    this.sequence = value.sequence;
    this.ppm = new PpmCountTrie(this.settings.maxOrder);
    this.ppm.restore(value.ppm);
    this.ppm.trim(this.settings.maxPatterns);
    this.sessions.clear();
    this.patterns.clear();
    for (const pattern of value.patterns) {
      if (pattern.context.length > this.settings.maxOrder || !isLearnedPattern(pattern)) continue;
      this.patterns.set(pattern.id, clonePattern(pattern));
    }
    this.trimPatterns();
    this.pools.clear();
    if (value.version === 2 && this.settings.persistBindingEvidence) {
      for (const item of value.pools) {
        const pool = parsePatternPool(item, this.settings);
        if (!pool) continue;
        if (pool.patternId && !this.patterns.has(pool.patternId)) delete pool.patternId;
        this.pools.set(pool.key, pool);
      }
      this.trimPools();
    }
    this.indexDirty = true;
    return true;
  }

  private learn(history: readonly ToolEvent[], target: ToolEvent): void {
    // Failed calls remain useful PPM context, but they are not authoritative
    // examples of a reusable input/output program.
    if (target.outcome !== "success") return;
    const observedPoolKeys = new Set<string>();
    for (const learningContext of learningContexts(
      history,
      this.settings.maxOrder,
      this.settings.learnCausalSubsequences,
    )) {
      const contextEvents = learningContext.events;
      if (contextEvents.some((event) => event.outcome !== "success")) continue;
      const capture = captureBindingEvidence(
        { context: contextEvents, target },
        this.settings.maxEvidenceCandidatesPerPath,
      );
      if (learningContext.projected && !bindingEvidenceHasOutputDependency(capture)) continue;
      const context = contextEvents.map(eventToken);
      const contextTools = contextEvents.map((event) => event.tool);
      const key = stableHash({
        context,
        targetTool: target.tool,
        targetSchemaHash: target.schemaHash,
      });
      if (observedPoolKeys.has(key)) continue;
      observedPoolKeys.add(key);
      const pool = this.pools.get(key) ?? {
        key,
        context,
        contextTools,
        targetTool: target.tool,
        ...(target.schemaHash ? { targetSchemaHash: target.schemaHash } : {}),
        observations: [],
      };
      pool.observations.push(capture.evidence);
      if (pool.observations.length > this.settings.maxSamplesPerPool) {
        pool.observations.shift();
      }
      this.pools.set(key, pool);
      if (pool.observations.length >= this.settings.minimumOccurrences) {
        this.rebuildPattern(pool, capture);
      }
    }
    this.trimPools();
  }

  private rebuildPattern(pool: PatternPool, current: BindingEvidenceCapture): void {
    const knownBindings = pool.patternId
      ? this.patterns.get(pool.patternId)?.bindings ?? {}
      : {};
    const inference = inferStableBindingsFromEvidence(pool.observations, current, knownBindings, {
      minimumReplayProbability: this.settings.minimumBindingReplayProbability,
      minimumConstantSupport: this.settings.minimumConstantSupport,
    });
    const id = stableHash({
      context: pool.context,
      targetTool: pool.targetTool,
      targetSchemaHash: pool.targetSchemaHash,
      bindings: inference.bindings,
      missing: inference.missing,
    });
    if (pool.patternId && pool.patternId !== id) this.patterns.delete(pool.patternId);
    const averageDurationMs =
      pool.observations.reduce((total, observation) => total + observation.durationMs, 0) /
      pool.observations.length;
    const pattern: LearnedToolPattern = {
      id,
      context: [...pool.context],
      contextTools: [...pool.contextTools],
      targetTool: pool.targetTool,
      ...(pool.targetSchemaHash ? { targetSchemaHash: pool.targetSchemaHash } : {}),
      bindings: structuredClone(inference.bindings),
      missing: inference.missing.map((value) => [...value]),
      occurrences: pool.observations.length,
      replayProbability: inference.replayProbability,
      averageDurationMs,
      lastSeenSequence: pool.observations.at(-1)?.sequence ?? this.sequence,
    };
    this.patterns.set(id, pattern);
    pool.patternId = id;
    this.indexDirty = true;
  }

  private expandPaths(
    initial: readonly PathFrontier[],
    schemaHashes: Readonly<Record<string, string>>,
  ): readonly FusionPath[] {
    const completed: PathFrontier[] = [];
    let frontier = [...initial];
    for (let depth = 0; depth < this.settings.maxPathDepth && frontier.length; depth++) {
      const next: PathFrontier[] = [];
      for (const item of frontier) {
        completed.push(item);
        for (const pattern of this.patternsMatchingToolSuffix(item.tools)) {
          if (item.visited.has(pattern.id)) continue;
          if (!matchesCurrentSchema(pattern, schemaHashes)) continue;
          const step = patternToStep(pattern, patternReliability(pattern));
          // A longer path is only a stronger fusion candidate when the new
          // step consumes an earlier structured result. Sequential calls with
          // entirely task-supplied arguments are ordinary workflow adjacency,
          // not evidence that the calls should be fused.
          const addedDataflowEdges = outputDependencyCount(step);
          if (addedDataflowEdges === 0) continue;
          const probability = clampProbability(item.probability * patternReliability(pattern));
          const visited = new Set(item.visited);
          visited.add(pattern.id);
          next.push({
            contextTools: item.contextTools,
            steps: [...item.steps, step],
            tools: [...item.tools, pattern.targetTool],
            probability,
            score: item.score + probability * Math.max(1, pattern.averageDurationMs),
            dataflowEdges: item.dataflowEdges + addedDataflowEdges,
            visited,
          });
        }
      }
      frontier = next
        .sort((left, right) => right.score - left.score || right.probability - left.probability)
        .slice(0, this.settings.maxSuggestions * this.settings.beamWidthPerTool);
    }
    const paths = completed
      .filter((item) => item.dataflowEdges > 0)
      .map(
        (item): FusionPath => ({
          contextTools: item.contextTools,
          steps: item.steps,
          tools: item.tools,
          probability: item.probability,
          score: item.score,
          dataflowEdges: item.dataflowEdges,
        }),
      );
    return deduplicatePaths(paths)
      .sort(
        (left, right) =>
          right.steps.length - left.steps.length ||
          right.score - left.score ||
          right.probability - left.probability ||
          left.tools.join("\0").localeCompare(right.tools.join("\0")),
      )
      .slice(0, this.settings.maxSuggestions);
  }

  private patternsMatchingToolSuffix(tools: readonly string[]): readonly LearnedToolPattern[] {
    if (!this.settings.indexToolSuffixes) {
      return [...this.patterns.values()].filter((pattern) =>
        matchesSuffix(tools, pattern.contextTools),
      );
    }
    this.ensureIndex();
    return [...this.toolPatternTrie.matching(tools)]
      .map((patternId) => this.patterns.get(patternId))
      .filter(
        (pattern): pattern is LearnedToolPattern =>
          pattern !== undefined && matchesSuffix(tools, pattern.contextTools),
      );
  }

  private ensureIndex(): void {
    if (!this.indexDirty) return;
    this.patternTrie = new SuffixPatternTrie();
    this.toolPatternTrie = new SuffixPatternTrie();
    for (const pattern of this.patterns.values()) {
      this.patternTrie.insert(pattern.context, pattern.id);
      this.toolPatternTrie.insert(pattern.contextTools, pattern.id);
    }
    this.indexDirty = false;
  }

  private snapshotPools(): readonly FusionPatternPoolSnapshot[] {
    const pools = [...this.pools.values()]
      .sort(
        (left, right) =>
          (right.observations.at(-1)?.sequence ?? 0) -
            (left.observations.at(-1)?.sequence ?? 0) ||
          left.key.localeCompare(right.key),
      )
      .slice(0, this.settings.maxPatterns * 2);
    const result: FusionPatternPoolSnapshot[] = [];
    let bytes = 2;
    for (const pool of pools) {
      const snapshot: FusionPatternPoolSnapshot = {
        key: pool.key,
        context: [...pool.context],
        contextTools: [...pool.contextTools],
        targetTool: pool.targetTool,
        ...(pool.targetSchemaHash ? { targetSchemaHash: pool.targetSchemaHash } : {}),
        observations: pool.observations.map(cloneBindingObservationEvidence),
        ...(pool.patternId ? { patternId: pool.patternId } : {}),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8") +
        (result.length > 0 ? 1 : 0);
      if (bytes + itemBytes > this.settings.maxPersistedEvidenceBytes) continue;
      result.push(snapshot);
      bytes += itemBytes;
    }
    return result;
  }

  private trimPools(): void {
    const limit = Math.max(this.settings.maxPatterns, this.settings.maxPatterns * 2);
    if (this.pools.size <= limit) return;
    const evicted = [...this.pools.values()]
      .sort(
        (left, right) =>
          (left.observations.at(-1)?.sequence ?? 0) -
            (right.observations.at(-1)?.sequence ?? 0) ||
          left.key.localeCompare(right.key),
      )
      .slice(0, this.pools.size - limit);
    for (const pool of evicted) this.pools.delete(pool.key);
  }

  private trimPatterns(): void {
    if (this.patterns.size <= this.settings.maxPatterns) return;
    const evicted = [...this.patterns.values()]
      .sort(
        (left, right) =>
          left.occurrences - right.occurrences ||
          left.lastSeenSequence - right.lastSeenSequence ||
          left.id.localeCompare(right.id),
      )
      .slice(0, this.patterns.size - this.settings.maxPatterns);
    for (const pattern of evicted) this.patterns.delete(pattern.id);
    this.indexDirty = true;
  }
}

export function eventToken(event: Pick<ToolEvent, "tool" | "outcome" | "schemaHash">): string {
  return stableStringify({
    tool: event.tool,
    outcome: event.outcome,
    ...(event.schemaHash ? { schemaHash: event.schemaHash } : {}),
  });
}

/**
 * Contiguous suffixes preserve ordinary PPM-style learning. Bounded projected
 * subsequences additionally expose causal data flow across unrelated calls,
 * mirroring speculative-action's future-gap modeling without speculating or
 * executing anything.
 */
function learningContexts(
  history: readonly ToolEvent[],
  maxOrder: number,
  includeProjected: boolean,
): readonly LearningContext[] {
  const bounded = history.slice(-Math.max(0, maxOrder));
  const result: LearningContext[] = [];
  const seen = new Set<string>();
  for (let length = 1; length <= bounded.length; length++) {
    const events = bounded.slice(-length);
    const key = events.map((event) => event.sequence).join(",");
    seen.add(key);
    result.push({ events, projected: false });
  }
  if (!includeProjected || bounded.length < 2) return result;

  // Keep the combinatorial projection bounded even if a caller configures a
  // very large PPM order. The default order of four explores all 15 subsets.
  const projectionWindow = bounded.slice(-Math.min(8, bounded.length));
  const combinations = 2 ** projectionWindow.length;
  for (let mask = combinations - 1; mask >= 1; mask--) {
    const events = projectionWindow.filter((_event, index) =>
      Boolean(mask & (1 << index)),
    );
    const key = events.map((event) => event.sequence).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ events, projected: true });
  }
  return result;
}

function normalizeEvent(
  observation: ToolObservation,
  sequence: number,
  batchId: string | undefined,
  batchIndex: number,
  batchSize: number,
): ToolEvent {
  const output = cloneUnknown(observation.output);
  return {
    sessionId: observation.sessionId,
    ...(observation.turnId ? { turnId: observation.turnId } : {}),
    ...(observation.callId ? { callId: observation.callId } : {}),
    tool: observation.tool,
    ...(observation.schemaHash ? { schemaHash: observation.schemaHash } : {}),
    input: structuredClone(observation.input),
    ...(output !== undefined ? { output } : {}),
    outcome: observation.outcome,
    ...(observation.durationMs !== undefined
      ? { durationMs: Math.max(0, finite(observation.durationMs)) }
      : {}),
    ...(observation.timestampMs !== undefined
      ? { timestampMs: finite(observation.timestampMs) }
      : {}),
    sequence,
    ...(batchId
      ? { batchId, batchIndex, batchSize }
      : {}),
  };
}

function candidateToStep(candidate: FusionCandidate): FusionPathStep {
  return {
    patternId: candidate.patternId,
    tool: candidate.tool,
    bindings: {},
    missing: candidate.missing,
    dependencies: candidate.dependencies,
    probability: candidate.probability,
  };
}

function patternToStep(pattern: LearnedToolPattern, probability: number): FusionPathStep {
  return {
    patternId: pattern.id,
    tool: pattern.targetTool,
    bindings: structuredClone(pattern.bindings),
    missing: pattern.missing.map((value) => [...value]),
    dependencies: bindingDependencies(pattern.bindings),
    probability,
  };
}

function outputDependencyCount(step: FusionPathStep): number {
  return step.dependencies.reduce(
    (count, dependency) =>
      count + dependency.sources.filter((source) => source.field === "output").length,
    0,
  );
}

function fusionContextTools(
  contextTools: readonly string[],
  step: FusionPathStep,
): readonly string[] {
  const requiredDepth = step.dependencies.reduce(
    (maximum, dependency) => Math.max(
      maximum,
      ...dependency.sources.map((source) => Math.abs(source.relativeEvent)),
    ),
    0,
  );
  return requiredDepth > 0 ? contextTools.slice(-requiredDepth) : [];
}

function patternReliability(pattern: LearnedToolPattern): number {
  const support = pattern.occurrences / (pattern.occurrences + 1);
  return clampProbability(support * pattern.replayProbability);
}

function matchesCurrentSchema(
  pattern: LearnedToolPattern,
  schemaHashes: Readonly<Record<string, string>>,
): boolean {
  const current = schemaHashes[pattern.targetTool];
  if (
    current !== undefined &&
    pattern.targetSchemaHash !== undefined &&
    current !== pattern.targetSchemaHash
  ) {
    return false;
  }
  return pattern.context.every((token) => contextSchemaMatches(token, schemaHashes));
}

function contextSchemaMatches(
  token: string,
  schemaHashes: Readonly<Record<string, string>>,
): boolean {
  try {
    const value: unknown = JSON.parse(token);
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const record = value as Record<string, unknown>;
    const tool = typeof record.tool === "string" ? record.tool : undefined;
    const learned = typeof record.schemaHash === "string" ? record.schemaHash : undefined;
    const current = tool ? schemaHashes[tool] : undefined;
    return current === undefined || learned === undefined || current === learned;
  } catch {
    return true;
  }
}

function comparePatterns(left: LearnedToolPattern, right: LearnedToolPattern): number {
  return (
    patternReliability(right) - patternReliability(left) ||
    right.occurrences - left.occurrences ||
    right.context.length - left.context.length ||
    right.lastSeenSequence - left.lastSeenSequence ||
    left.id.localeCompare(right.id)
  );
}

function clonePattern(pattern: LearnedToolPattern): LearnedToolPattern {
  return {
    ...pattern,
    context: [...pattern.context],
    contextTools: [...pattern.contextTools],
    bindings: structuredClone(pattern.bindings),
    missing: pattern.missing.map((value) => [...value]),
  };
}

function cloneBindingObservationEvidence(
  observation: BindingObservationEvidence,
): BindingObservationEvidence {
  return {
    sessionHash: observation.sessionHash,
    durationMs: observation.durationMs,
    sequence: observation.sequence,
    paths: Object.fromEntries(
      Object.entries(observation.paths).map(([encodedPath, evidence]) => [
        encodedPath,
        {
          candidateHashes: [...evidence.candidateHashes],
          ...(evidence.constantHash ? { constantHash: evidence.constantHash } : {}),
          ...(evidence.secret ? { secret: true as const } : {}),
        },
      ]),
    ),
  };
}

function parsePatternPool(
  value: unknown,
  settings: FusionLearnerSettings,
): PatternPool | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const context = stringArray(record.context);
  const contextTools = stringArray(record.contextTools);
  const targetTool = typeof record.targetTool === "string" ? record.targetTool : undefined;
  const targetSchemaHash =
    typeof record.targetSchemaHash === "string" ? record.targetSchemaHash : undefined;
  if (
    typeof record.key !== "string" ||
    !isFingerprint(record.key) ||
    !context ||
    context.length === 0 ||
    context.length > settings.maxOrder ||
    !contextTools ||
    contextTools.length !== context.length ||
    !targetTool ||
    (record.targetSchemaHash !== undefined && targetSchemaHash === undefined) ||
    !Array.isArray(record.observations) ||
    (record.patternId !== undefined &&
      (typeof record.patternId !== "string" || !isFingerprint(record.patternId)))
  ) {
    return undefined;
  }
  const expectedKey = stableHash({ context, targetTool, targetSchemaHash });
  if (record.key !== expectedKey) return undefined;
  const observations = record.observations
    .map((item) => parseBindingObservationEvidence(item, settings.maxEvidenceCandidatesPerPath))
    .filter((item): item is BindingObservationEvidence => item !== undefined)
    .slice(-settings.maxSamplesPerPool);
  if (!observations.length) return undefined;
  return {
    key: record.key,
    context,
    contextTools,
    targetTool,
    ...(targetSchemaHash ? { targetSchemaHash } : {}),
    observations,
    ...(typeof record.patternId === "string" ? { patternId: record.patternId } : {}),
  };
}

function parseBindingObservationEvidence(
  value: unknown,
  maxCandidatesPerPath: number,
): BindingObservationEvidence | undefined {
  const record = asRecord(value);
  const paths = asRecord(record?.paths);
  if (
    !record ||
    !isFingerprint(record.sessionHash) ||
    typeof record.durationMs !== "number" ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0 ||
    !Number.isSafeInteger(record.sequence) ||
    Number(record.sequence) < 0 ||
    !paths
  ) {
    return undefined;
  }
  const normalizedPaths: Record<string, BindingObservationEvidence["paths"][string]> = {};
  for (const [encodedPath, item] of Object.entries(paths)) {
    const evidence = asRecord(item);
    if (
      !isEncodedSafePath(encodedPath) ||
      !evidence ||
      !Array.isArray(evidence.candidateHashes) ||
      !evidence.candidateHashes.every(isFingerprint) ||
      (evidence.constantHash !== undefined && !isFingerprint(evidence.constantHash)) ||
      (evidence.secret !== undefined && evidence.secret !== true)
    ) {
      return undefined;
    }
    if (evidence.secret === true) {
      normalizedPaths[encodedPath] = { candidateHashes: [], secret: true };
      continue;
    }
    normalizedPaths[encodedPath] = {
      candidateHashes: [...new Set(evidence.candidateHashes as string[])]
        .slice(0, maxCandidatesPerPath),
      ...(typeof evidence.constantHash === "string"
        ? { constantHash: evidence.constantHash }
        : {}),
    };
  }
  return {
    sessionHash: record.sessionHash as string,
    durationMs: record.durationMs,
    sequence: Number(record.sequence),
    paths: normalizedPaths,
  };
}

function deduplicateCandidates(candidates: readonly FusionCandidate[]): FusionCandidate[] {
  const result = new Map<string, FusionCandidate>();
  for (const candidate of candidates) {
    const key = stableStringify({
      tool: candidate.tool,
      input: candidate.input,
      missing: candidate.missing,
    });
    const existing = result.get(key);
    if (!existing || candidate.score > existing.score) result.set(key, candidate);
  }
  return [...result.values()];
}

function deduplicatePaths(paths: readonly FusionPath[]): FusionPath[] {
  const result = new Map<string, FusionPath>();
  for (const path of paths) {
    const key = stableStringify({
      tools: path.tools,
      steps: path.steps.map((step) => ({ tool: step.tool, bindings: step.bindings })),
    });
    const existing = result.get(key);
    if (!existing || path.score > existing.score) result.set(key, path);
  }
  return [...result.values()];
}

function perToolBeam(candidates: readonly FusionCandidate[], width: number): FusionCandidate[] {
  const counts = new Map<string, number>();
  return candidates.filter((candidate) => {
    const count = counts.get(candidate.tool) ?? 0;
    if (count >= width) return false;
    counts.set(candidate.tool, count + 1);
    return true;
  });
}

function matchesSuffix(history: readonly string[], context: readonly string[]): boolean {
  if (!context.length || context.length > history.length) return false;
  const offset = history.length - context.length;
  return context.every((token, index) => token === history[offset + index]);
}

function normalizeSettings(value: Partial<FusionLearnerSettings>): FusionLearnerSettings {
  return {
    maxOrder: positiveInteger(value.maxOrder, FUSION_LEARNER_DEFAULTS.maxOrder),
    minimumOccurrences: positiveInteger(
      value.minimumOccurrences,
      FUSION_LEARNER_DEFAULTS.minimumOccurrences,
    ),
    minimumBindingReplayProbability: probability(
      value.minimumBindingReplayProbability,
      FUSION_LEARNER_DEFAULTS.minimumBindingReplayProbability,
    ),
    minimumConstantSupport: positiveInteger(
      value.minimumConstantSupport,
      FUSION_LEARNER_DEFAULTS.minimumConstantSupport,
    ),
    decayHalfLifeEvents: positiveInteger(
      value.decayHalfLifeEvents,
      FUSION_LEARNER_DEFAULTS.decayHalfLifeEvents,
    ),
    maxPatterns: positiveInteger(value.maxPatterns, FUSION_LEARNER_DEFAULTS.maxPatterns),
    maxSamplesPerPool: positiveInteger(
      value.maxSamplesPerPool,
      FUSION_LEARNER_DEFAULTS.maxSamplesPerPool,
    ),
    maxSessionEvents: positiveInteger(
      value.maxSessionEvents,
      FUSION_LEARNER_DEFAULTS.maxSessionEvents,
    ),
    maxSuggestions: positiveInteger(
      value.maxSuggestions,
      FUSION_LEARNER_DEFAULTS.maxSuggestions,
    ),
    beamWidthPerTool: positiveInteger(
      value.beamWidthPerTool,
      FUSION_LEARNER_DEFAULTS.beamWidthPerTool,
    ),
    maxPathDepth: positiveInteger(
      value.maxPathDepth,
      FUSION_LEARNER_DEFAULTS.maxPathDepth,
    ),
    maxEvidenceCandidatesPerPath: positiveInteger(
      value.maxEvidenceCandidatesPerPath,
      FUSION_LEARNER_DEFAULTS.maxEvidenceCandidatesPerPath,
    ),
    maxPersistedEvidenceBytes: positiveInteger(
      value.maxPersistedEvidenceBytes,
      FUSION_LEARNER_DEFAULTS.maxPersistedEvidenceBytes,
    ),
    persistBindingEvidence: booleanSetting(
      value.persistBindingEvidence,
      FUSION_LEARNER_DEFAULTS.persistBindingEvidence,
    ),
    learnCausalSubsequences: booleanSetting(
      value.learnCausalSubsequences,
      FUSION_LEARNER_DEFAULTS.learnCausalSubsequences,
    ),
    indexToolSuffixes: booleanSetting(
      value.indexToolSuffixes,
      FUSION_LEARNER_DEFAULTS.indexToolSuffixes,
    ),
  };
}

function isSnapshot(value: unknown): value is FusionLearnerSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    (snapshot.version === 1 || snapshot.version === 2) &&
    Number.isSafeInteger(snapshot.sequence) &&
    Number(snapshot.sequence) >= 0 &&
    Array.isArray(snapshot.ppm) &&
    Array.isArray(snapshot.patterns) &&
    (snapshot.version === 1 || Array.isArray(snapshot.pools))
  );
}

function isLearnedPattern(value: unknown): value is LearnedToolPattern {
  if (!value || typeof value !== "object") return false;
  const pattern = value as Partial<LearnedToolPattern>;
  return (
    typeof pattern.id === "string" &&
    Array.isArray(pattern.context) &&
    pattern.context.every((item) => typeof item === "string") &&
    Array.isArray(pattern.contextTools) &&
    pattern.contextTools.every((item) => typeof item === "string") &&
    typeof pattern.targetTool === "string" &&
    (pattern.targetSchemaHash === undefined || typeof pattern.targetSchemaHash === "string") &&
    isBindingRecord(pattern.bindings) &&
    bindingsFitContext(pattern.bindings, pattern.context.length) &&
    Array.isArray(pattern.missing) &&
    pattern.missing.every(isValuePath) &&
    [
      pattern.occurrences,
      pattern.replayProbability,
      pattern.averageDurationMs,
      pattern.lastSeenSequence,
    ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
  );
}

function isBindingRecord(value: unknown): value is Readonly<Record<string, ValueBinding>> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([encodedPath, binding]) => isEncodedSafePath(encodedPath) && isBinding(binding, 0),
    )
  );
}

function bindingsFitContext(
  bindings: Readonly<Record<string, ValueBinding>>,
  contextLength: number,
): boolean {
  return bindingDependencies(bindings).every((dependency) =>
    dependency.sources.every(
      (source) => Math.abs(source.relativeEvent) <= contextLength,
    ),
  );
}

function isEncodedSafePath(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isValuePath(parsed) && parsed.length > 0 && parsed.every(
      (segment) => !["__proto__", "prototype", "constructor"].includes(String(segment)),
    );
  } catch {
    return false;
  }
}

function isBinding(value: unknown, depth: number): value is ValueBinding {
  if (!value || typeof value !== "object" || depth > 12) return false;
  const binding = value as Partial<ValueBinding> & Record<string, unknown>;
  if (binding.type === "constant") return true;
  if (binding.type === "event") {
    return (
      typeof binding.relativeEvent === "number" &&
      Number.isInteger(binding.relativeEvent) &&
      binding.relativeEvent < 0 &&
      (binding.field === "input" || binding.field === "output") &&
      isValuePath(binding.path)
    );
  }
  if (binding.type === "template") {
    return (
      typeof binding.prefix === "string" &&
      typeof binding.suffix === "string" &&
      isBinding(binding.source, depth + 1)
    );
  }
  if (binding.type === "transform") {
    return (
      ["dirname", "basename", "normalize_path"].includes(String(binding.operation)) &&
      isBinding(binding.source, depth + 1)
    );
  }
  return (
    binding.type === "join" &&
    binding.operation === "join_path" &&
    isBinding(binding.left, depth + 1) &&
    isBinding(binding.right, depth + 1)
  );
}

function isValuePath(value: unknown): value is readonly (string | number)[] {
  return (
    Array.isArray(value) &&
    value.every(
      (segment) => typeof segment === "string" || (Number.isSafeInteger(segment) && segment >= 0),
    )
  );
}

function cloneUnknown(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function probability(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function booleanSetting(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

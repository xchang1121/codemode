import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CODE_MODE_INSTRUCTIONS,
  CODE_MODE_META_KEY,
  codeModeSessionId,
  codeModeToolDefinitions,
  parseCodeModeRequest,
  type CodeModeDescribeInput,
  type CodeModeExecuteInput,
  type CodeModeSearchInput,
  type CodeModeSuggestInput,
} from "../code-mode/contract.js";
import { stableStringify } from "../core/stable.js";
import type { CodeExecutor } from "../execution/types.js";
import {
  fusionHintText,
  renderFusionHints,
  type RenderedFusionHint,
} from "../hints/fusion-hints.js";
import { FusionLearner } from "../learning/fusion-learner.js";
import type { FusionPath, ToolObservation } from "../learning/types.js";
import {
  renderToolDeclaration,
  renderToolSdk,
} from "../tools/schema-to-typescript.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolInvocationTrace, ToolResult } from "../tools/types.js";

export type HintDelivery = "content" | "meta" | "both" | "off";

export interface CodeModeGatewayOptions {
  readonly registry: ToolRegistry;
  readonly executor: CodeExecutor;
  readonly learner?: FusionLearner;
  readonly exposeDirectTools?: boolean;
  readonly hintDelivery?: HintDelivery;
  readonly maxActiveHints?: number;
  readonly name?: string;
  readonly version?: string;
  /** Runs after authoritative observations update the learner. */
  readonly onLearnerChanged?: (learner: FusionLearner) => void;
}

interface BufferedBatch {
  readonly expected: number;
  readonly traces: Map<number, ToolInvocationTrace>;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CodeModeGateway {
  readonly server: Server;
  readonly learner: FusionLearner;
  private readonly registry: ToolRegistry;
  private readonly executor: CodeExecutor;
  private readonly exposeDirectTools: boolean;
  private readonly hintDelivery: HintDelivery;
  private readonly maxActiveHints: number;
  private readonly onLearnerChanged: ((learner: FusionLearner) => void) | undefined;
  private readonly batches = new Map<string, BufferedBatch>();
  private readonly removeListener: () => void;
  private lastHintSignature = "";
  private closed = false;

  constructor(options: CodeModeGatewayOptions) {
    this.registry = options.registry;
    this.executor = options.executor;
    this.learner = options.learner ?? new FusionLearner();
    this.exposeDirectTools = options.exposeDirectTools ?? true;
    this.hintDelivery = options.hintDelivery ?? "both";
    this.maxActiveHints = Math.max(0, Math.floor(options.maxActiveHints ?? 2));
    this.onLearnerChanged = options.onLearnerChanged;
    this.server = new Server(
      {
        name: options.name ?? "codemode-gateway",
        version: options.version ?? "0.1.0",
      },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: CODE_MODE_INSTRUCTIONS,
      },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listTools() }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = asRecord(request.params.arguments) ?? {};
      const sessionId = codeModeSessionId(extra.sessionId, extra._meta);
      try {
        const codeModeRequest = parseCodeModeRequest(request.params.name, args);
        if (codeModeRequest) {
          switch (codeModeRequest.kind) {
            case "search":
              return this.search(codeModeRequest.input);
            case "describe":
              return this.describe(codeModeRequest.input);
            case "suggest":
              return this.suggest(codeModeRequest.input, sessionId);
            case "execute":
              return await this.execute(codeModeRequest.input, sessionId, extra.signal);
          }
        }
        const tool = this.registry.get(request.params.name);
        if (!this.exposeDirectTools || !tool) {
          return errorResult(new Error(`Unknown gateway tool: ${request.params.name}`));
        }
        const result = await this.registry.call(tool.id, args, {
          sessionId,
          callId: String(extra.requestId),
          source: "direct",
          signal: extra.signal,
        });
        return this.attachHints(result, this.activeHints(sessionId));
      } catch (error) {
        return errorResult(error);
      }
    });
    this.lastHintSignature = this.currentHintSignature();
    this.removeListener = this.registry.onInvocation((trace) => this.observeTrace(trace));
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  listTools(): readonly Tool[] {
    const tools = codeModeToolDefinitions();
    if (!this.exposeDirectTools) return tools;
    const common = renderFusionHints(
      this.learner.commonPaths(8, this.registry.schemaHashes()),
      this.registry,
      8,
    );
    for (const registered of this.registry.list()) {
      const related = common
        .filter((hint) => hint.tools.includes(`${registered.namespace}.${registered.originalName}`))
        .slice(0, 2);
      const suffix = related.length
        ? `\n\nLearned Code Mode paths: ${related.map((hint) => hint.tools.join(" → ")).join("; ")}`
        : "";
      tools.push({
        ...structuredClone(registered.definition),
        name: registered.gatewayName,
        description: `${registered.definition.description ?? registered.originalName}\n\nUpstream tool id: ${registered.id}.${suffix}`,
        _meta: {
          ...registered.definition._meta,
          [CODE_MODE_META_KEY]: {
            upstreamToolId: registered.id,
            codeReference: this.registry.codeReference(registered.id),
            fusionHints: related,
          },
        },
      });
    }
    return tools;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeListener();
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
    await Promise.allSettled([this.server.close(), this.registry.close()]);
  }

  private search(input: CodeModeSearchInput): CallToolResult {
    const { query, limit } = input;
    const tools = this.registry.search(query, limit);
    const pathHints = this.filterHints(
      this.learner.commonPaths(limit, this.registry.schemaHashes()),
      query,
    );
    const structuredContent = {
      tools: tools.map((tool) => ({
        id: tool.id,
        gatewayName: tool.gatewayName,
        codeReference: this.registry.codeReference(tool.id),
        description: tool.definition.description ?? "",
        declaration: renderToolDeclaration(tool),
      })),
      fusionPaths: pathHints,
    };
    return jsonResult(structuredContent);
  }

  private describe(input: CodeModeDescribeInput): CallToolResult {
    const { names } = input;
    const tools = names.map((name) => this.registry.require(name));
    const structuredContent = {
      tools: tools.map((tool) => ({
        id: tool.id,
        gatewayName: tool.gatewayName,
        codeReference: this.registry.codeReference(tool.id),
        description: tool.definition.description ?? "",
        inputSchema: tool.definition.inputSchema,
        ...(tool.definition.outputSchema ? { outputSchema: tool.definition.outputSchema } : {}),
        declaration: renderToolDeclaration(tool),
      })),
      sdk: renderToolSdk(tools),
    };
    return jsonResult(structuredContent);
  }

  private suggest(
    input: CodeModeSuggestInput,
    sessionId: string,
  ): CallToolResult {
    const { task, limit } = input;
    const schemaHashes = this.registry.schemaHashes();
    const sessionPaths = this.learner.predictPaths(sessionId, schemaHashes);
    const paths = sessionPaths.length
      ? sessionPaths
      : this.learner.commonPaths(limit * 2, schemaHashes);
    const hints = this.filterHints(paths, task).slice(0, limit);
    return jsonResult({ hints });
  }

  private async execute(
    input: CodeModeExecuteInput,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const { code, description, allowedTools } = input;
    const result = await this.executor.execute({
      code,
      allowedTools,
      sessionId,
      description,
      signal,
    });
    const structuredContent = {
      value: result.value,
      logs: result.logs,
      toolCalls: result.toolCalls,
      durationMs: result.durationMs,
    };
    return this.attachHints(jsonResult(structuredContent), this.activeHints(sessionId));
  }

  private observeTrace(trace: ToolInvocationTrace): void {
    const batchId = trace.context.batchId;
    const batchSize = trace.context.batchSize;
    const batchIndex = trace.context.batchIndex;
    if (!batchId || batchSize === undefined || batchIndex === undefined || batchSize <= 1) {
      this.observeTraces([trace]);
      return;
    }
    let batch = this.batches.get(batchId);
    if (!batch) {
      const timer = setTimeout(() => this.flushBatch(batchId), 1_000);
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
    this.observeTraces([...batch.traces.entries()].sort(([left], [right]) => left - right).map(([, trace]) => trace));
  }

  private observeTraces(traces: readonly ToolInvocationTrace[]): void {
    const observations = traces.map(traceObservation);
    if (observations.length > 1) this.learner.observeBatch(observations);
    else if (observations[0]) this.learner.observe(observations[0]);
    try {
      this.onLearnerChanged?.(this.learner);
    } catch {
      // Persistence/telemetry hooks must not change authoritative tool behavior.
    }
    this.notifyHintChanges();
  }

  private notifyHintChanges(): void {
    const signature = this.currentHintSignature();
    if (signature === this.lastHintSignature) return;
    this.lastHintSignature = signature;
    if (this.server.transport) void this.server.sendToolListChanged().catch(() => undefined);
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

  private activeHints(sessionId: string): readonly RenderedFusionHint[] {
    if (this.hintDelivery === "off" || this.maxActiveHints === 0) return [];
    return renderFusionHints(
      this.learner.predictPaths(sessionId, this.registry.schemaHashes()),
      this.registry,
      this.maxActiveHints,
    );
  }

  private filterHints(paths: readonly FusionPath[], task: string): readonly RenderedFusionHint[] {
    const hints = renderFusionHints(paths, this.registry, paths.length);
    const terms = task.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
    if (!terms.length) return hints;
    const matched = hints.filter((hint) => {
      const text = `${hint.summary} ${hint.code}`.toLowerCase();
      return terms.some((term) => text.includes(term));
    });
    return matched.length ? matched : hints;
  }

  private attachHints(result: ToolResult, hints: readonly RenderedFusionHint[]): CallToolResult {
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

function jsonResult(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function errorResult(error: unknown): CallToolResult {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${name}: ${message}` }],
    _meta: { [CODE_MODE_META_KEY]: { error: { name, message } } },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

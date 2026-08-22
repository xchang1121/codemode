import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
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

const CODEMODE_SEARCH = "codemode_search";
const CODEMODE_DESCRIBE = "codemode_describe";
const CODEMODE_SUGGEST = "codemode_suggest";
const CODEMODE_EXECUTE = "codemode_execute";
const HINT_META_KEY = "io.github.xchang1121/codemode";

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
    this.server = new Server(
      {
        name: options.name ?? "codemode-gateway",
        version: options.version ?? "0.1.0",
      },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: [
          "This server exposes ordinary tools plus Code Mode.",
          "Use codemode_search and codemode_describe to discover typed tools.",
          "Use codemode_suggest to inspect learned multi-tool paths.",
          "Use codemode_execute for dependent calls, loops, branching, filtering or parallel calls.",
          "Every codemode_execute request must include an explicit allowed_tools list.",
        ].join(" "),
      },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listTools() }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = asRecord(request.params.arguments) ?? {};
      const sessionId = requestSessionId(extra.sessionId, extra._meta);
      try {
        if (request.params.name === CODEMODE_SEARCH) return this.search(args);
        if (request.params.name === CODEMODE_DESCRIBE) return this.describe(args);
        if (request.params.name === CODEMODE_SUGGEST) return this.suggest(args, sessionId);
        if (request.params.name === CODEMODE_EXECUTE) {
          return await this.execute(args, sessionId, extra.signal);
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
    this.removeListener = this.registry.onInvocation((trace) => this.observeTrace(trace));
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  listTools(): readonly Tool[] {
    const tools: Tool[] = [
      searchTool(),
      describeTool(),
      suggestTool(),
      executeTool(),
    ];
    if (!this.exposeDirectTools) return tools;
    const common = renderFusionHints(this.learner.commonPaths(8), this.registry, 8);
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
          [HINT_META_KEY]: {
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

  private search(args: Readonly<Record<string, unknown>>): CallToolResult {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = numberArgument(args.limit, 12, 1, 50);
    const tools = this.registry.search(query, limit);
    const pathHints = this.filterHints(this.learner.commonPaths(limit), query);
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

  private describe(args: Readonly<Record<string, unknown>>): CallToolResult {
    const names = Array.isArray(args.names)
      ? args.names.filter((value): value is string => typeof value === "string")
      : [];
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
    args: Readonly<Record<string, unknown>>,
    sessionId: string,
  ): CallToolResult {
    const task = typeof args.task === "string" ? args.task : "";
    const limit = numberArgument(args.limit, 5, 1, 20);
    const sessionPaths = this.learner.predictPaths(sessionId);
    const paths = sessionPaths.length ? sessionPaths : this.learner.commonPaths(limit * 2);
    const hints = this.filterHints(paths, task).slice(0, limit);
    return jsonResult({ hints });
  }

  private async execute(
    args: Readonly<Record<string, unknown>>,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const code = typeof args.code === "string" ? args.code : "";
    const description = typeof args.description === "string" ? args.description : undefined;
    const allowedTools = Array.isArray(args.allowed_tools)
      ? args.allowed_tools.filter((value): value is string => typeof value === "string")
      : [];
    const result = await this.executor.execute({
      code,
      allowedTools,
      sessionId,
      ...(description ? { description } : {}),
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
    this.notifyHintChanges();
  }

  private notifyHintChanges(): void {
    const signature = stableStringify(
      this.learner.commonPaths(8).map((path) => ({
        tools: path.tools,
        probability: Math.round(path.probability * 100),
      })),
    );
    if (signature === this.lastHintSignature) return;
    this.lastHintSignature = signature;
    if (this.server.transport) void this.server.sendToolListChanged().catch(() => undefined);
  }

  private activeHints(sessionId: string): readonly RenderedFusionHint[] {
    if (this.hintDelivery === "off" || this.maxActiveHints === 0) return [];
    return renderFusionHints(
      this.learner.predictPaths(sessionId),
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
              [HINT_META_KEY]: { fusionHints: hints },
            },
          }
        : {}),
    };
  }
}

function searchTool(): Tool {
  return {
    name: CODEMODE_SEARCH,
    description:
      "Search upstream tools and learned fusion paths without loading the full catalog. Call this before codemode_describe when the relevant tools are unknown.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Capability or task to search for" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: objectOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  };
}

function describeTool(): Tool {
  return {
    name: CODEMODE_DESCRIBE,
    description:
      "Return exact input/output schemas, code references and TypeScript declarations for selected upstream tools.",
    inputSchema: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
      },
      required: ["names"],
      additionalProperties: false,
    },
    outputSchema: objectOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  };
}

function suggestTool(): Tool {
  return {
    name: CODEMODE_SUGGEST,
    description:
      "Show PPM + trie learned tool paths whose structured results can feed later tool arguments. Returns executable JavaScript skeletons.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Optional task text used to filter paths" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      },
      additionalProperties: false,
    },
    outputSchema: objectOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  };
}

function executeTool(): Tool {
  return {
    name: CODEMODE_EXECUTE,
    description: [
      "Execute the body of one async JavaScript function in an isolated QuickJS/WASM sandbox.",
      "Use await tools[namespace][name](args) for dependent calls and Promise.all for independent calls.",
      "Only tools named in allowed_tools exist inside the sandbox. No filesystem, process, environment or direct network APIs are available.",
      "Call codemode_search/codemode_describe first if exact tool schemas are not known.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short summary of the program" },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          uniqueItems: true,
          description: "Explicit upstream tool IDs or gateway names available to the program",
        },
        code: {
          type: "string",
          description: "JavaScript function body. Top-level await and return are supported.",
        },
      },
      required: ["description", "allowed_tools", "code"],
      additionalProperties: false,
    },
    outputSchema: objectOutputSchema(),
  };
}

function objectOutputSchema(): Tool["outputSchema"] {
  return { type: "object", additionalProperties: true };
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

function requestSessionId(sessionId: string | undefined, meta: unknown): string {
  const record = asRecord(meta);
  const supplied = record?.["io.github.xchang1121/codemode-session"];
  return typeof supplied === "string" && supplied ? supplied : sessionId ?? "default";
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
    _meta: { [HINT_META_KEY]: { error: { name, message } } },
  };
}

function numberArgument(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

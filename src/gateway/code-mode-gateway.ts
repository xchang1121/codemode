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
import type { CodeExecutor } from "../execution/types.js";
import {
  FusionAdvisor,
  type FusionAdvisorPort,
  type HintDelivery,
} from "../hints/fusion-advisor.js";
import { FusionLearner } from "../learning/fusion-learner.js";
import {
  renderToolDeclaration,
  renderToolSdk,
} from "../tools/schema-to-typescript.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

export type { HintDelivery } from "../hints/fusion-advisor.js";

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

export class CodeModeGateway {
  readonly server: Server;
  readonly learner: FusionLearner;
  private readonly registry: ToolRegistry;
  private readonly executor: CodeExecutor;
  private readonly exposeDirectTools: boolean;
  private readonly advisor: FusionAdvisorPort;
  private readonly removeHintsListener: () => void;
  private closed = false;

  constructor(options: CodeModeGatewayOptions) {
    this.registry = options.registry;
    this.executor = options.executor;
    this.exposeDirectTools = options.exposeDirectTools ?? true;
    const advisor = new FusionAdvisor({
      registry: options.registry,
      ...(options.learner ? { learner: options.learner } : {}),
      ...(options.hintDelivery ? { hintDelivery: options.hintDelivery } : {}),
      ...(options.maxActiveHints !== undefined
        ? { maxActiveHints: options.maxActiveHints }
        : {}),
      ...(options.onLearnerChanged
        ? { onLearnerChanged: options.onLearnerChanged }
        : {}),
    });
    this.advisor = advisor;
    this.learner = advisor.learner;
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
        return this.advisor.attachHints(result, sessionId);
      } catch (error) {
        return errorResult(error);
      }
    });
    this.removeHintsListener = this.advisor.onHintsChanged(() => {
      if (this.server.transport) void this.server.sendToolListChanged().catch(() => undefined);
    });
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  listTools(): readonly Tool[] {
    const tools = codeModeToolDefinitions();
    if (!this.exposeDirectTools) return tools;
    const common = this.advisor.commonHints("", 8);
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
    this.removeHintsListener();
    this.advisor.close();
    await Promise.allSettled([this.server.close(), this.registry.close()]);
  }

  private search(input: CodeModeSearchInput): CallToolResult {
    const { query, limit } = input;
    const tools = this.registry.search(query, limit);
    const pathHints = this.advisor.commonHints(query, limit);
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
    const hints = this.advisor.suggestHints(sessionId, task, limit);
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
    return this.advisor.attachHints(jsonResult(structuredContent), sessionId);
  }
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

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CODE_MODE_META_KEY,
  codeModeToolDefinitions,
  parseCodeModeRequest,
  type CodeModeDescribeInput,
  type CodeModeExecuteInput,
  type CodeModeSearchInput,
  type CodeModeSuggestInput,
} from "./contract.js";
import type { CodeExecutor } from "../execution/types.js";
import {
  renderToolDeclaration,
  renderToolSdk,
} from "../tools/schema-to-typescript.js";
import type {
  CodeModeToolRegistryPort,
  FusionAdvisorPort,
} from "./ports.js";

export interface CodeModeCallRequest {
  readonly name: string;
  readonly arguments?: unknown;
  readonly sessionId: string;
  readonly callId?: string;
  readonly signal: AbortSignal;
}

/** MCP-independent application boundary consumed by the northbound adapter. */
export interface CodeModeApplicationPort {
  listTools(): readonly Tool[];
  call(request: CodeModeCallRequest): Promise<CallToolResult>;
  onToolsChanged(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface CodeModeServiceOptions {
  readonly registry: CodeModeToolRegistryPort;
  readonly executor: CodeExecutor;
  readonly advisor: FusionAdvisorPort;
  readonly exposeDirectTools?: boolean;
  /** The default composition owns its registry; shared embedders may leave this false. */
  readonly closeRegistry?: boolean;
}

/**
 * Transport-neutral Code Mode use cases. It owns request dispatch and result
 * shaping, while execution and learning remain replaceable ports.
 */
export class CodeModeService implements CodeModeApplicationPort {
  private readonly registry: CodeModeToolRegistryPort;
  private readonly executor: CodeExecutor;
  private readonly advisor: FusionAdvisorPort;
  private readonly exposeDirectTools: boolean;
  private readonly closeRegistry: boolean;
  private closed = false;

  constructor(options: CodeModeServiceOptions) {
    this.registry = options.registry;
    this.executor = options.executor;
    this.advisor = options.advisor;
    this.exposeDirectTools = options.exposeDirectTools ?? true;
    this.closeRegistry = options.closeRegistry ?? false;
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

  async call(request: CodeModeCallRequest): Promise<CallToolResult> {
    const args = asRecord(request.arguments) ?? {};
    try {
      const codeModeRequest = parseCodeModeRequest(request.name, args);
      if (codeModeRequest) {
        switch (codeModeRequest.kind) {
          case "search":
            return this.search(codeModeRequest.input);
          case "describe":
            return this.describe(codeModeRequest.input);
          case "suggest":
            return this.suggest(codeModeRequest.input, request.sessionId);
          case "execute":
            return await this.execute(
              codeModeRequest.input,
              request.sessionId,
              request.signal,
            );
        }
      }
      const tool = this.registry.get(request.name);
      if (!this.exposeDirectTools || !tool) {
        return errorResult(new Error(`Unknown gateway tool: ${request.name}`));
      }
      const result = await this.registry.call(tool.id, args, {
        sessionId: request.sessionId,
        ...(request.callId ? { callId: request.callId } : {}),
        source: "direct",
        signal: request.signal,
      });
      return this.advisor.attachHints(result, request.sessionId);
    } catch (error) {
      return errorResult(error);
    }
  }

  onToolsChanged(listener: () => void): () => void {
    return this.advisor.onHintsChanged(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.advisor.close();
    if (this.closeRegistry) await this.registry.close();
  }

  private search(input: CodeModeSearchInput): CallToolResult {
    const { query, limit } = input;
    const tools = this.registry.search(query, limit);
    const structuredContent = {
      tools: tools.map((tool) => ({
        id: tool.id,
        gatewayName: tool.gatewayName,
        codeReference: this.registry.codeReference(tool.id),
        description: tool.definition.description ?? "",
        declaration: renderToolDeclaration(tool),
      })),
      fusionPaths: this.advisor.commonHints(query, limit),
    };
    return jsonResult(structuredContent);
  }

  private describe(input: CodeModeDescribeInput): CallToolResult {
    const tools = input.names.map((name) => this.registry.require(name));
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

  private suggest(input: CodeModeSuggestInput, sessionId: string): CallToolResult {
    const hints = this.advisor.suggestHints(sessionId, input.task, input.limit);
    return jsonResult({ hints });
  }

  private async execute(
    input: CodeModeExecuteInput,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const result = await this.executor.execute({
      code: input.code,
      allowedTools: input.allowedTools,
      sessionId,
      description: input.description,
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

export function jsonResult(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function errorResult(error: unknown): CallToolResult {
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

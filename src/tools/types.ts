import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type ToolDefinition = Tool;
export type ToolResult = CallToolResult;

export interface ToolProviderCallContext {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  /** Calls issued in one guest microtask share a batch to avoid sibling causality. */
  readonly batchId?: string;
  readonly batchIndex?: number;
  readonly batchSize?: number;
}

export interface ToolProvider {
  readonly namespace: string;
  connect?(): Promise<void>;
  listTools(): Promise<readonly ToolDefinition[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: ToolProviderCallContext,
  ): Promise<ToolResult>;
  close?(): Promise<void>;
}

export interface RegisteredTool {
  readonly id: string;
  readonly namespace: string;
  readonly originalName: string;
  readonly gatewayName: string;
  readonly codeNamespace: string;
  readonly codeName: string;
  readonly definition: ToolDefinition;
  readonly schemaHash: string;
}

export type ToolCallSource = "direct" | "code";

export interface ToolCallContext {
  readonly sessionId: string;
  readonly callId?: string;
  readonly source: ToolCallSource;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Calls issued in one guest microtask share a batch to avoid sibling causality. */
  readonly batchId?: string;
  readonly batchIndex?: number;
  readonly batchSize?: number;
}

export interface ToolInvocationRequest {
  readonly tool: RegisteredTool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly context: ToolCallContext;
}

export interface ToolInvocationTrace extends ToolInvocationRequest {
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly result?: ToolResult;
  readonly error?: unknown;
}

export interface ToolPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type ToolPolicy = (
  request: ToolInvocationRequest,
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;

export type ToolInvocationListener = (trace: ToolInvocationTrace) => void;

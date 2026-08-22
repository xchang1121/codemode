import type { RenderedFusionHint } from "../hints/fusion-hints.js";
import type {
  RegisteredTool,
  ToolCallContext,
  ToolResult,
} from "../tools/types.js";

export type HintDelivery = "content" | "meta" | "both" | "off";

/** Learning/presentation behavior needed by the application service. */
export interface FusionAdvisorPort {
  commonHints(task: string, limit: number): readonly RenderedFusionHint[];
  suggestHints(sessionId: string, task: string, limit: number): readonly RenderedFusionHint[];
  activeHints(sessionId: string): readonly RenderedFusionHint[];
  attachHints(result: ToolResult, sessionId: string): ToolResult;
  onHintsChanged(listener: () => void): () => void;
  close(): void;
}

/** Authoritative catalog/dispatch behavior needed by CodeModeService. */
export interface CodeModeToolRegistryPort {
  list(): readonly RegisteredTool[];
  get(idOrGatewayName: string): RegisteredTool | undefined;
  require(idOrGatewayName: string): RegisteredTool;
  search(query: string, limit?: number): readonly RegisteredTool[];
  codeReference(idOrGatewayName: string): string;
  call(
    idOrGatewayName: string,
    args: Readonly<Record<string, unknown>>,
    context: ToolCallContext,
  ): Promise<ToolResult>;
  close(): Promise<void>;
}

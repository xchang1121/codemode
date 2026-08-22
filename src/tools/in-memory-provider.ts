import type {
  ToolDefinition,
  ToolProvider,
  ToolProviderCallContext,
  ToolResult,
} from "./types.js";

export type InMemoryToolHandler = (
  args: Readonly<Record<string, unknown>>,
  context: ToolProviderCallContext,
) => ToolResult | Promise<ToolResult>;

export interface InMemoryTool {
  readonly definition: ToolDefinition;
  readonly handler: InMemoryToolHandler;
}

export class InMemoryToolProvider implements ToolProvider {
  readonly namespace: string;
  private readonly tools = new Map<string, InMemoryTool>();

  constructor(namespace: string, tools: readonly InMemoryTool[]) {
    this.namespace = namespace;
    for (const tool of tools) this.tools.set(tool.definition.name, tool);
  }

  async listTools(): Promise<readonly ToolDefinition[]> {
    return [...this.tools.values()].map((tool) => structuredClone(tool.definition));
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: ToolProviderCallContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown in-memory tool: ${name}`);
    return tool.handler(args, context);
  }
}

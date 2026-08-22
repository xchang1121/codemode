import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  ToolDefinition,
  ToolProvider,
  ToolProviderCallContext,
  ToolResult,
} from "./types.js";

export interface StdioMcpProviderConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxBufferSize?: number;
}

export interface HttpMcpProviderConfig {
  readonly transport: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type McpProviderConfig = StdioMcpProviderConfig | HttpMcpProviderConfig;

export class McpToolProvider implements ToolProvider {
  readonly namespace: string;
  private readonly config: McpProviderConfig | undefined;
  private client: Client | undefined;
  private injectedTransport: Transport | undefined;

  constructor(namespace: string, config: McpProviderConfig) {
    this.namespace = namespace;
    this.config = config;
  }

  static fromTransport(namespace: string, transport: Transport): McpToolProvider {
    const provider = Object.create(McpToolProvider.prototype) as McpToolProvider;
    Object.defineProperty(provider, "namespace", { value: namespace, enumerable: true });
    provider.injectedTransport = transport;
    return provider;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const client = new Client(
      { name: `codemode-upstream-${this.namespace}`, version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = this.injectedTransport ?? createTransport(this.config);
    try {
      await client.connect(transport);
      this.client = client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(): Promise<readonly ToolDefinition[]> {
    const client = this.requireClient();
    const tools: ToolDefinition[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...result.tools.map((tool) => structuredClone(tool)));
      cursor = result.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`Upstream ${this.namespace} repeated tools/list cursor ${cursor}`);
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: ToolProviderCallContext,
  ): Promise<ToolResult> {
    const client = this.requireClient();
    const result = await client.callTool(
      { name, arguments: structuredClone(args) },
      CallToolResultSchema,
      {
        signal: context.signal,
        ...(context.timeoutMs !== undefined ? { timeout: context.timeoutMs } : {}),
      },
    );
    const parsed = CallToolResultSchema.safeParse(result);
    if (!parsed.success) throw new Error(`Upstream ${this.namespace} returned an invalid tool result`);
    return parsed.data;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close();
  }

  private requireClient(): Client {
    if (!this.client) throw new Error(`MCP provider ${this.namespace} is not connected`);
    return this.client;
  }
}

function createTransport(config: McpProviderConfig | undefined): Transport {
  if (!config) throw new Error("An MCP provider transport is required");
  if (config.transport === "stdio") {
    const parameters: StdioServerParameters = {
      command: config.command,
      ...(config.args ? { args: [...config.args] } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env
        ? { env: { ...getDefaultEnvironment(), ...config.env } }
        : {}),
      ...(config.maxBufferSize !== undefined ? { maxBufferSize: config.maxBufferSize } : {}),
      stderr: "inherit",
    };
    return new StdioClientTransport(parameters);
  }
  const options: StreamableHTTPClientTransportOptions = config.headers
    ? { requestInit: { headers: { ...config.headers } } }
    : {};
  // SDK 1.x's StreamableHTTP transport has an optional-property declaration
  // that is structurally narrower under exactOptionalPropertyTypes.
  return new StreamableHTTPClientTransport(new URL(config.url), options) as unknown as Transport;
}

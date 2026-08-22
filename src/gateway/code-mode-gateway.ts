import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createDefaultCodeModeApplication,
  type DefaultCodeModeApplication,
  type DefaultCodeModeApplicationOptions,
} from "../code-mode/composition.js";
import {
  CODE_MODE_INSTRUCTIONS,
  codeModeSessionId,
} from "../code-mode/contract.js";
import type { CodeModeApplicationPort } from "../code-mode/service.js";

export type { HintDelivery } from "../code-mode/composition.js";

export interface CodeModeGatewayOptions extends DefaultCodeModeApplicationOptions {
  readonly name?: string;
  readonly version?: string;
}

/** Thin northbound MCP adapter; all Code Mode behavior lives behind application. */
export class CodeModeGateway {
  readonly server: Server;
  readonly learner: DefaultCodeModeApplication["learner"];
  private readonly application: CodeModeApplicationPort;
  private readonly removeToolsChangedListener: () => void;
  private closed = false;

  constructor(options: CodeModeGatewayOptions) {
    const composed = createDefaultCodeModeApplication(options);
    this.application = composed.application;
    this.learner = composed.learner;
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
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      this.application.call({
        name: request.params.name,
        ...(request.params.arguments !== undefined
          ? { arguments: request.params.arguments }
          : {}),
        sessionId: codeModeSessionId(extra.sessionId, extra._meta),
        callId: String(extra.requestId),
        signal: extra.signal,
      }));
    this.removeToolsChangedListener = this.application.onToolsChanged(() => {
      if (this.server.transport) void this.server.sendToolListChanged().catch(() => undefined);
    });
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  listTools(): readonly Tool[] {
    return this.application.listTools();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeToolsChangedListener();
    await Promise.allSettled([this.server.close(), this.application.close()]);
  }
}

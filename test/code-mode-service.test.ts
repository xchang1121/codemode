import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CodeModeService } from "../src/code-mode/service.js";
import type { CodeExecutionRequest } from "../src/execution/types.js";
import type { FusionAdvisorPort } from "../src/hints/fusion-advisor.js";
import type { RenderedFusionHint } from "../src/hints/fusion-hints.js";
import { InMemoryToolProvider } from "../src/tools/in-memory-provider.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { ToolResult } from "../src/tools/types.js";

describe("CodeModeService", () => {
  let registry: ToolRegistry;
  let advisor: StubAdvisor;
  let execution: CodeExecutionRequest | undefined;
  let service: CodeModeService;

  beforeEach(async () => {
    registry = new ToolRegistry();
    await registry.addProvider(new InMemoryToolProvider("demo", [{
      definition: {
        name: "echo",
        description: "Echo one value",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      handler: (args) => ({ content: [], structuredContent: { value: args.value } }),
    }]));
    advisor = new StubAdvisor();
    service = new CodeModeService({
      registry,
      advisor,
      executor: {
        execute: async (request) => {
          execution = request;
          return { value: { ok: true }, logs: ["done"], toolCalls: 1, durationMs: 2 };
        },
      },
    });
  });

  afterEach(async () => {
    await service.close();
    await registry.close();
  });

  test("runs discovery, direct calls and programs without an MCP transport", async () => {
    expect(service.listTools().map((tool) => tool.name)).toEqual([
      "codemode_search",
      "codemode_describe",
      "codemode_suggest",
      "codemode_execute",
      "demo__echo",
    ]);

    const searched = await service.call(request("codemode_search", { query: "echo" }));
    expect(searched.structuredContent).toEqual(expect.objectContaining({
      tools: [expect.objectContaining({ id: "demo::echo" })],
      fusionPaths: [HINT],
    }));

    const direct = await service.call(request("demo__echo", { value: "hello" }));
    expect(direct.structuredContent).toEqual({ value: "hello" });
    expect(direct._meta).toEqual({ stubAdvisor: true });

    const executed = await service.call(request("codemode_execute", {
      description: "Echo through code",
      allowed_tools: ["demo::echo"],
      code: "return tools.demo.echo({ value: 'hello' });",
    }));
    expect(executed.structuredContent).toEqual({
      value: { ok: true },
      logs: ["done"],
      toolCalls: 1,
      durationMs: 2,
    });
    expect(execution).toEqual(expect.objectContaining({
      allowedTools: ["demo::echo"],
      sessionId: "service-test",
    }));
  });

  test("forwards only semantic catalog changes and owns the advisor lifecycle", async () => {
    let changes = 0;
    const remove = service.onToolsChanged(() => {
      changes++;
    });
    advisor.emitChanged();
    expect(changes).toBe(1);
    remove();
    advisor.emitChanged();
    expect(changes).toBe(1);

    await service.close();
    expect(advisor.closed).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });
});

const HINT: RenderedFusionHint = {
  allowedTools: ["demo::echo"],
  tools: ["demo.echo"],
  probability: 1,
  dataflowEdges: 1,
  summary: "demo.echo",
  code: "return tools.demo.echo({ value: 'hello' });",
};

class StubAdvisor implements FusionAdvisorPort {
  readonly listeners = new Set<() => void>();
  closed = false;

  commonHints(): readonly RenderedFusionHint[] {
    return [HINT];
  }

  suggestHints(): readonly RenderedFusionHint[] {
    return [HINT];
  }

  activeHints(): readonly RenderedFusionHint[] {
    return [HINT];
  }

  attachHints(result: ToolResult): ToolResult {
    return { ...result, _meta: { ...result._meta, stubAdvisor: true } };
  }

  onHintsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitChanged(): void {
    for (const listener of this.listeners) listener();
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

function request(name: string, args: unknown) {
  return {
    name,
    arguments: args,
    sessionId: "service-test",
    callId: "call-1",
    signal: new AbortController().signal,
  };
}

import { describe, expect, test } from "vitest";
import { InMemoryToolProvider } from "../src/tools/in-memory-provider.js";
import { ToolPolicyError, ToolValidationError } from "../src/tools/errors.js";
import { ToolRegistry, toolResultValue } from "../src/tools/tool-registry.js";

describe("ToolRegistry", () => {
  test("namespaces, validates, calls and observes structured tools", async () => {
    const traces: string[] = [];
    const registry = new ToolRegistry();
    registry.onInvocation((trace) => traces.push(`${trace.context.source}:${trace.tool.id}`));
    await registry.addProvider(
      new InMemoryToolProvider("demo", [
        {
          definition: {
            name: "double",
            description: "Double a number",
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
              additionalProperties: false,
            },
            outputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
          handler: (args) => ({
            content: [{ type: "text", text: String(Number(args.value) * 2) }],
            structuredContent: { value: Number(args.value) * 2 },
          }),
        },
      ]),
    );

    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: "demo::double",
        gatewayName: "demo__double",
        schemaHash: expect.any(String),
      }),
    ]);
    const result = await registry.call("demo__double", { value: 3 }, {
      sessionId: "one",
      source: "direct",
    });
    expect(toolResultValue(result)).toEqual({ value: 6 });
    expect(traces).toEqual(["direct:demo::double"]);
    await expect(
      registry.call("demo::double", { value: "bad" }, { sessionId: "one", source: "direct" }),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  test("validates structured output and preserves text-only envelopes", async () => {
    const registry = new ToolRegistry();
    await registry.addProvider(
      new InMemoryToolProvider("demo", [
        {
          definition: {
            name: "invalid",
            inputSchema: { type: "object" },
            outputSchema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          },
          handler: () => ({ content: [], structuredContent: { ok: "no" } }),
        },
        {
          definition: { name: "text", inputSchema: { type: "object" } },
          handler: () => ({ content: [{ type: "text", text: "hello" }] }),
        },
        {
          definition: {
            name: "missing_structured",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
          handler: () => ({ content: [{ type: "text", text: "not enough" }] }),
        },
      ]),
    );

    await expect(
      registry.call("demo::invalid", {}, { sessionId: "one", source: "direct" }),
    ).rejects.toBeInstanceOf(ToolValidationError);
    await expect(
      registry.call("demo::missing_structured", {}, {
        sessionId: "one",
        source: "direct",
      }),
    ).rejects.toBeInstanceOf(ToolValidationError);
    expect(
      toolResultValue(
        await registry.call("demo::text", {}, { sessionId: "one", source: "direct" }),
      ),
    ).toEqual({ content: [{ type: "text", text: "hello" }], isError: false });
  });

  test("enforces policy for every call", async () => {
    const registry = new ToolRegistry({
      policy: ({ tool }) => ({
        allowed: tool.originalName !== "delete",
        reason: "destructive calls are disabled",
      }),
    });
    await registry.addProvider(
      new InMemoryToolProvider("demo", [
        {
          definition: { name: "delete", inputSchema: { type: "object" } },
          handler: () => ({ content: [] }),
        },
      ]),
    );

    await expect(
      registry.call("demo::delete", {}, { sessionId: "one", source: "code" }),
    ).rejects.toBeInstanceOf(ToolPolicyError);
  });

  test("creates deterministic collision-safe gateway names", async () => {
    const registry = new ToolRegistry();
    await registry.addProvider(
      new InMemoryToolProvider("demo", [
        {
          definition: { name: "a/b", inputSchema: { type: "object" } },
          handler: () => ({ content: [] }),
        },
        {
          definition: { name: "a_b", inputSchema: { type: "object" } },
          handler: () => ({ content: [] }),
        },
      ]),
    );

    const names = registry.list().map((tool) => tool.gatewayName);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("demo__a_b");
  });

  test("does not start a provider call when its signal is already aborted", async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    await registry.addProvider(
      new InMemoryToolProvider("demo", [
        {
          definition: { name: "side_effect", inputSchema: { type: "object" } },
          handler: () => {
            calls++;
            return { content: [] };
          },
        },
      ]),
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));

    await expect(
      registry.call("demo::side_effect", {}, {
        sessionId: "cancelled",
        source: "direct",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before dispatch");
    expect(calls).toBe(0);
  });
});

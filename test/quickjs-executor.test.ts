import { beforeEach, describe, expect, test } from "vitest";
import { CodeExecutionBudgetError, CodeExecutionError } from "../src/execution/errors.js";
import { QuickJsCodeExecutor } from "../src/execution/quickjs-executor.js";
import { InMemoryToolProvider } from "../src/tools/in-memory-provider.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

describe("QuickJsCodeExecutor", () => {
  let registry: ToolRegistry;
  let executor: QuickJsCodeExecutor;
  let active = 0;
  let maximumActive = 0;

  beforeEach(async () => {
    active = 0;
    maximumActive = 0;
    registry = new ToolRegistry();
    await registry.addProvider(
      new InMemoryToolProvider("demo", [
        {
          definition: {
            name: "seed",
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
            outputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
          handler: (args) => ({ content: [], structuredContent: { value: args.value } }),
        },
        {
          definition: {
            name: "double",
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
            outputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
          handler: (args) => ({
            content: [],
            structuredContent: { value: Number(args.value) * 2 },
          }),
        },
        {
          definition: {
            name: "wait",
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
            outputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
          handler: async (args, context) => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            try {
              await delay(10, context.signal);
              return { content: [], structuredContent: { value: args.value } };
            } finally {
              active--;
            }
          },
        },
        {
          definition: {
            name: "fail",
            inputSchema: { type: "object", additionalProperties: false },
          },
          handler: () => {
            throw new Error("provider failed");
          },
        },
      ]),
    );
    executor = new QuickJsCodeExecutor(registry);
  });

  test("runs dependent tool calls and returns only the program result", async () => {
    const result = await executor.execute({
      sessionId: "one",
      allowedTools: ["demo::seed", "demo::double"],
      code: `
        const seed = await tools.demo.seed({ value: 3 });
        const doubled = await tools.demo.double({ value: seed.value });
        console.log("doubled", doubled.value);
        return doubled.value;
      `,
    });

    expect(result).toMatchObject({ value: 6, toolCalls: 2, logs: ["doubled 6"] });
  });

  test("supports Promise.all while enforcing host-side concurrency", async () => {
    const result = await executor.execute({
      sessionId: "parallel",
      allowedTools: ["demo::wait"],
      code: `
        const values = await Promise.all(
          [1, 2, 3, 4].map(value => tools.demo.wait({ value }))
        );
        return values.map(item => item.value);
      `,
      limits: { maxConcurrentToolCalls: 2 },
    });

    expect(result.value).toEqual([1, 2, 3, 4]);
    expect(maximumActive).toBe(2);
  });

  test("does not expose host process, network or module globals", async () => {
    const result = await executor.execute({
      sessionId: "isolation",
      allowedTools: ["demo::seed"],
      code: "return [typeof process, typeof require, typeof fetch];",
    });

    expect(result.value).toEqual(["undefined", "undefined", "undefined"]);
  });

  test("rejects tools outside the explicit allowlist", async () => {
    await expect(
      executor.execute({
        sessionId: "denied",
        allowedTools: ["demo::seed"],
        code: "return tools.demo.double({ value: 2 });",
      }),
    ).rejects.toBeInstanceOf(CodeExecutionError);
  });

  test("exposes an allowed subcall failure as ToolCallError inside the program", async () => {
    const result = await executor.execute({
      sessionId: "failure",
      allowedTools: ["demo::fail"],
      code: `
        try {
          await tools.demo.fail({});
        } catch (error) {
          return {
            typed: error instanceof ToolCallError,
            name: error.name,
            toolName: error.toolName,
            message: error.message,
          };
        }
      `,
    });

    expect(result.value).toEqual({
      typed: true,
      name: "ToolCallError",
      toolName: "tools.demo.fail",
      message: "Error: provider failed",
    });
  });

  test("interrupts infinite guest loops", async () => {
    // Warm the shared WASM module so this assertion measures guest execution.
    await executor.execute({
      sessionId: "warmup",
      allowedTools: ["demo::seed"],
      code: "return 1;",
    });

    await expect(
      executor.execute({
        sessionId: "timeout",
        allowedTools: ["demo::seed"],
        code: "while (true) {}",
        limits: { timeoutMs: 30 },
      }),
    ).rejects.toBeInstanceOf(CodeExecutionError);
  });

  test("enforces the total tool-call budget", async () => {
    await expect(
      executor.execute({
        sessionId: "budget",
        allowedTools: ["demo::seed"],
        code: `
          await tools.demo.seed({ value: 1 });
          return tools.demo.seed({ value: 2 });
        `,
        limits: { maxToolCalls: 1 },
      }),
    ).rejects.toBeInstanceOf(CodeExecutionError);
  });

  test("rejects oversized source before creating a VM", async () => {
    await expect(
      executor.execute({
        sessionId: "source-budget",
        allowedTools: ["demo::seed"],
        code: "return 1;".repeat(20),
        limits: { maxCodeBytes: 16 },
      }),
    ).rejects.toBeInstanceOf(CodeExecutionBudgetError);
  });
});

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

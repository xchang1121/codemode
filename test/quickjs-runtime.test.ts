import { describe, expect, test } from "vitest";
import { QuickJsCodeRuntime } from "../src/execution/quickjs-runtime.js";

describe("QuickJsCodeRuntime", () => {
  test("executes arbitrary host bindings without knowing about the tool registry", async () => {
    const runtime = new QuickJsCodeRuntime();
    const result = await runtime.run({
      program: `
        const seeded = await host.math.seed({ value: 3 });
        const doubled = await host.math.double({ value: seeded.value });
        console.log("result", doubled.value);
        return doubled;
      `,
      bindings: [{
        global: "host",
        members: [
          {
            path: ["math", "seed"],
            invoke: async (args) => ({ value: Number(asRecord(args).value) }),
          },
          {
            path: ["math", "double"],
            invoke: async (args) => ({ value: Number(asRecord(args).value) * 2 }),
          },
        ],
      }],
    });

    expect(result).toEqual({ value: { value: 6 }, logs: ["result 6"] });
    expect(runtime.language).toBe("javascript");
    expect(runtime.isolation).toBe("wasm");
  });

  test("materializes the consumer-declared binding error inside the program", async () => {
    const runtime = new QuickJsCodeRuntime();
    const result = await runtime.run({
      program: `
        try {
          await host.records.load({});
        } catch (error) {
          return {
            typed: error instanceof HostCallError,
            name: error.name,
            binding: error.bindingName,
            message: error.message,
          };
        }
      `,
      bindings: [{
        global: "host",
        errorClass: { name: "HostCallError", memberNameProperty: "bindingName" },
        members: [{
          path: ["records", "load"],
          invoke: async () => {
            throw new Error("record unavailable");
          },
        }],
      }],
    });

    expect(result.value).toEqual({
      typed: true,
      name: "HostCallError",
      binding: "host.records.load",
      message: "Error: record unavailable",
    });
  });

  test("reports program failures as result data", async () => {
    const runtime = new QuickJsCodeRuntime();
    const thrown = await runtime.run({
      program: 'throw new Error("guest failed");',
      bindings: [],
    });
    const invalid = await runtime.run({
      program: "return { missing: undefined };",
      bindings: [],
    });

    expect(thrown.error).toEqual(
      expect.objectContaining({ kind: "exception", message: expect.stringContaining("guest failed") }),
    );
    expect(invalid.error).toEqual(
      expect.objectContaining({ kind: "invalid-output", message: expect.stringContaining("lossless JSON") }),
    );
  });

  test("aborts and drains unawaited bindings when the program settles", async () => {
    let aborted = false;
    const runtime = new QuickJsCodeRuntime();
    const result = await runtime.run({
      program: "host.jobs.slow({}); return 'done';",
      bindings: [{
        global: "host",
        members: [{
          path: ["jobs", "slow"],
          invoke: (_args, context) => new Promise((_resolve, reject) => {
            const onAbort = () => {
              aborted = true;
              reject(new Error("aborted"));
            };
            if (context.signal.aborted) onAbort();
            else context.signal.addEventListener("abort", onAbort, { once: true });
          }),
        }],
      }],
    });

    expect(result).toEqual({ value: "done", logs: [] });
    expect(aborted).toBe(true);
  });

  test("hard-interrupts synchronous guest loops at the runtime boundary", async () => {
    const runtime = new QuickJsCodeRuntime({ timeoutMs: 25 });
    const result = await runtime.run({ program: "while (true) {}", bindings: [] });

    expect(result.error).toEqual(
      expect.objectContaining({ kind: "timeout", message: expect.stringContaining("25ms") }),
    );
  });

  test("rejects invalid binding declarations as contract misuse", async () => {
    const runtime = new QuickJsCodeRuntime();

    await expect(runtime.run({
      program: "return 1;",
      bindings: [{ global: "console", members: [] }],
    })).rejects.toThrow("Invalid binding namespace name");
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected object");
  }
  return value as Record<string, unknown>;
}

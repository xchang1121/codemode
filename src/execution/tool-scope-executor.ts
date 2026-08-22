import { ToolExecutionError } from "../tools/errors.js";
import { toolResultValue, type ToolRegistry } from "../tools/tool-registry.js";
import type { RegisteredTool } from "../tools/types.js";
import {
  type CodeBindingMember,
  type CodeJsonValue,
  type CodeRuntime,
  snapshotCodeJson,
} from "./code-runtime.js";
import {
  CodeExecutionBudgetError,
  CodeExecutionError,
  CodeExecutionTimeoutError,
} from "./errors.js";
import {
  DEFAULT_CODE_EXECUTION_LIMITS,
  type CodeExecutionLimits,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeExecutor,
} from "./types.js";

/** A backend factory keeps runtime-specific configuration out of the tool scope. */
export type CodeRuntimeFactory = (limits: CodeExecutionLimits) => CodeRuntime;

/**
 * The DSH-style consumer side of Code Mode. One execute call creates one
 * explicit tool scope, bridges every binding through ToolRegistry, then drops
 * the whole scope when the program settles.
 */
export class ToolScopeCodeExecutor implements CodeExecutor {
  private readonly registry: ToolRegistry;
  private readonly runtimeFactory: CodeRuntimeFactory;
  private readonly defaults: CodeExecutionLimits;
  private executionSequence = 0;

  constructor(
    registry: ToolRegistry,
    runtimeFactory: CodeRuntimeFactory,
    defaults: Partial<CodeExecutionLimits> = {},
  ) {
    this.registry = registry;
    this.runtimeFactory = runtimeFactory;
    this.defaults = normalizeLimits({ ...DEFAULT_CODE_EXECUTION_LIMITS, ...defaults });
  }

  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const limits = normalizeLimits({ ...this.defaults, ...request.limits });
    if (Buffer.byteLength(request.code, "utf8") > limits.maxCodeBytes) {
      throw new CodeExecutionBudgetError(`Code exceeds ${limits.maxCodeBytes} byte limit`);
    }
    const allowed = new Map(
      request.allowedTools.map((name) => {
        const tool = this.registry.require(name);
        return [tool.id, tool] as const;
      }),
    );
    if (!allowed.size) throw new CodeExecutionBudgetError("At least one allowed tool is required");

    const executionId = ++this.executionSequence;
    const startedAtMs = Date.now();
    const deadline = startedAtMs + limits.timeoutMs;
    const controller = new AbortController();
    const detachAbort = relayAbort(request.signal, controller);
    const timeoutError = new CodeExecutionTimeoutError(limits.timeoutMs);
    const timer = setTimeout(() => controller.abort(timeoutError), limits.timeoutMs);
    timer.unref?.();
    const semaphore = new Semaphore(limits.maxConcurrentToolCalls);
    let toolCalls = 0;
    let resultBytes = 0;
    let batchCounter = 0;
    let activeBatch: ExecutionBatch | undefined;

    const allocateBatch = (): { readonly batch: ExecutionBatch; readonly index: number } => {
      if (!activeBatch) {
        let ready: () => void = () => {};
        const batch: ExecutionBatch = {
          id: `code-${executionId}-batch-${++batchCounter}`,
          size: 0,
          ready: new Promise<void>((resolve) => {
            ready = resolve;
          }),
        };
        activeBatch = batch;
        queueMicrotask(() => {
          if (activeBatch === batch) activeBatch = undefined;
          ready();
        });
      }
      const batch = activeBatch;
      const index = batch.size++;
      return { batch, index };
    };

    const binding = (tool: RegisteredTool): CodeBindingMember => ({
      path: [tool.codeNamespace, tool.codeName],
      invoke: async (rawArgs, context): Promise<CodeJsonValue> => {
        const allocated = allocateBatch();
        let release: () => void = () => undefined;
        try {
          await allocated.batch.ready;
          release = await semaphore.acquire(context.signal);
          if (context.signal.aborted) throw abortReason(context.signal);
          if (++toolCalls > limits.maxToolCalls) {
            throw new CodeExecutionBudgetError(
              `Tool call count exceeds ${limits.maxToolCalls}`,
            );
          }
          if (!isRecord(rawArgs)) {
            throw new CodeExecutionError(`Tool ${tool.id} arguments must be an object`);
          }
          const remaining = Math.max(1, deadline - Date.now());
          const result = await this.registry.call(tool.id, rawArgs, {
            sessionId: request.sessionId,
            callId: `code-${executionId}-${toolCalls}`,
            source: "code",
            signal: context.signal,
            timeoutMs: Math.min(limits.perToolTimeoutMs, remaining),
            batchId: allocated.batch.id,
            batchIndex: allocated.index,
            batchSize: allocated.batch.size,
          });
          if (result.isError) throw new ToolExecutionError(tool.id, result);
          const value = snapshotCodeJson(toolResultValue(result), `Tool ${tool.id} result`);
          resultBytes += Buffer.byteLength(JSON.stringify(value), "utf8");
          if (resultBytes > limits.maxResultBytes) {
            throw new CodeExecutionBudgetError(
              `Tool results exceed ${limits.maxResultBytes} byte limit`,
            );
          }
          return value;
        } finally {
          release();
        }
      },
    });

    try {
      const runtime = this.runtimeFactory(limits);
      const result = await runtime.run({
        program: request.code,
        bindings: [{
          global: "tools",
          members: [...allowed.values()].map(binding),
          errorClass: { name: "ToolCallError", memberNameProperty: "toolName" },
        }],
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw abortReason(controller.signal);
      if (result.error) {
        const captured = result.logs.length > 0
          ? `\nCaptured output:\n${result.logs.join("\n")}`
          : "";
        const message = `code run failed (${result.error.kind}): ${result.error.message}${captured}`;
        if (result.error.kind === "timeout") throw timeoutError;
        if (result.error.kind === "output-limit") throw new CodeExecutionBudgetError(message);
        throw new CodeExecutionError(message);
      }
      return {
        value: result.value ?? null,
        logs: result.logs,
        toolCalls,
        durationMs: Date.now() - startedAtMs,
      };
    } finally {
      clearTimeout(timer);
      detachAbort();
      if (!controller.signal.aborted) controller.abort(new Error("Code execution completed"));
    }
  }
}

function normalizeLimits(value: CodeExecutionLimits): CodeExecutionLimits {
  return {
    timeoutMs: positiveInteger(value.timeoutMs, DEFAULT_CODE_EXECUTION_LIMITS.timeoutMs),
    perToolTimeoutMs: positiveInteger(
      value.perToolTimeoutMs,
      DEFAULT_CODE_EXECUTION_LIMITS.perToolTimeoutMs,
    ),
    memoryLimitBytes: positiveInteger(
      value.memoryLimitBytes,
      DEFAULT_CODE_EXECUTION_LIMITS.memoryLimitBytes,
    ),
    maxStackBytes: positiveInteger(value.maxStackBytes, DEFAULT_CODE_EXECUTION_LIMITS.maxStackBytes),
    maxCodeBytes: positiveInteger(value.maxCodeBytes, DEFAULT_CODE_EXECUTION_LIMITS.maxCodeBytes),
    maxToolCalls: positiveInteger(value.maxToolCalls, DEFAULT_CODE_EXECUTION_LIMITS.maxToolCalls),
    maxConcurrentToolCalls: positiveInteger(
      value.maxConcurrentToolCalls,
      DEFAULT_CODE_EXECUTION_LIMITS.maxConcurrentToolCalls,
    ),
    maxResultBytes: positiveInteger(
      value.maxResultBytes,
      DEFAULT_CODE_EXECUTION_LIMITS.maxResultBytes,
    ),
    maxLogEntries: nonNegativeInteger(
      value.maxLogEntries,
      DEFAULT_CODE_EXECUTION_LIMITS.maxLogEntries,
    ),
  };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new CodeExecutionError("Code execution aborted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.queue.indexOf(start);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortReason(signal));
        };
        this.queue.push(start);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (signal.aborted) throw abortReason(signal);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

interface ExecutionBatch {
  readonly id: string;
  size: number;
  readonly ready: Promise<void>;
}

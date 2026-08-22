import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { ToolExecutionError } from "../tools/errors.js";
import { toolResultValue, type ToolRegistry } from "../tools/tool-registry.js";
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

export class QuickJsCodeExecutor implements CodeExecutor {
  private readonly registry: ToolRegistry;
  private readonly defaults: CodeExecutionLimits;
  private executionSequence = 0;

  constructor(
    registry: ToolRegistry,
    defaults: Partial<CodeExecutionLimits> = {},
  ) {
    this.registry = registry;
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
    const logs: string[] = [];
    const pending = new Set<Promise<void>>();
    const deferreds = new Set<QuickJSDeferredPromise>();
    let toolCalls = 0;
    let resultBytes = 0;
    let closed = false;
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

    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();
    vm.runtime.setMemoryLimit(limits.memoryLimitBytes);
    vm.runtime.setMaxStackSize(limits.maxStackBytes);
    vm.runtime.setInterruptHandler(() => controller.signal.aborted || Date.now() >= deadline);

    const settleJobs = (): void => {
      if (closed || !vm.alive || controller.signal.aborted) return;
      const jobs = vm.runtime.executePendingJobs();
      if (jobs.error) {
        const error = dumpQuickJsError(vm, jobs.error);
        jobs.error.dispose();
        controller.abort(error);
      }
    };

    const hostCall = vm.newFunction("__codemode_call_tool", (nameHandle, argsHandle) => {
      const deferred = vm.newPromise();
      deferreds.add(deferred);
      const id = vm.getString(nameHandle);
      const dumped: unknown = vm.dump(argsHandle);
      const allocated = allocateBatch();
      const operation = (async () => {
        let release: () => void = () => undefined;
        try {
          await allocated.batch.ready;
          release = await semaphore.acquire(controller.signal);
          if (controller.signal.aborted) throw abortReason(controller.signal);
          if (++toolCalls > limits.maxToolCalls) {
            throw new CodeExecutionBudgetError(
              `Tool call count exceeds ${limits.maxToolCalls}`,
            );
          }
          if (!allowed.has(id)) throw new CodeExecutionBudgetError(`Tool is not allowed: ${id}`);
          if (!isRecord(dumped)) throw new CodeExecutionError(`Tool ${id} arguments must be an object`);
          const remaining = Math.max(1, deadline - Date.now());
          const result = await this.registry.call(id, dumped, {
            sessionId: request.sessionId,
            callId: `code-${executionId}-${toolCalls}`,
            source: "code",
            signal: controller.signal,
            timeoutMs: Math.min(limits.perToolTimeoutMs, remaining),
            batchId: allocated.batch.id,
            batchIndex: allocated.index,
            batchSize: allocated.batch.size,
          });
          if (result.isError) throw new ToolExecutionError(id, result);
          const value = toolResultValue(result);
          const serialized = serializeJson(value);
          resultBytes += Buffer.byteLength(serialized, "utf8");
          if (resultBytes > limits.maxResultBytes) {
            throw new CodeExecutionBudgetError(
              `Tool results exceed ${limits.maxResultBytes} byte limit`,
            );
          }
          if (closed) return;
          const handle = jsonHandle(vm, serialized);
          deferred.resolve(handle);
          handle.dispose();
        } catch (error) {
          if (closed) return;
          const errorHandle = vm.newError(formatError(error));
          deferred.reject(errorHandle);
          errorHandle.dispose();
        } finally {
          release();
        }
      })();
      const tracked = operation.finally(() => {
        pending.delete(tracked);
        void deferred.settled.finally(() => {
          settleJobs();
          deferreds.delete(deferred);
          deferred.dispose();
        });
      });
      pending.add(tracked);
      return deferred.handle;
    });
    vm.setProp(vm.global, "__codemode_call_tool", hostCall);
    hostCall.dispose();

    const hostLog = vm.newFunction("__codemode_log", (...handles) => {
      if (logs.length >= limits.maxLogEntries) return vm.undefined;
      const values = handles.map((handle) => {
        const value: unknown = vm.dump(handle);
        return typeof value === "string" ? value : safeDisplay(value);
      });
      logs.push(values.join(" "));
      return vm.undefined;
    });
    vm.setProp(vm.global, "__codemode_log", hostLog);
    hostLog.dispose();

    let promiseHandle: QuickJSHandle | undefined;
    let resultHandle: QuickJSHandle | undefined;
    try {
      const bootstrap = buildBootstrap([...allowed.values()].map((tool) => ({
        id: tool.id,
        namespace: tool.codeNamespace,
        name: tool.codeName,
      })));
      const evaluation = vm.evalCode(`${bootstrap}\n${wrapCode(request.code)}`, "codemode-user.js");
      if (evaluation.error) {
        const error = dumpQuickJsError(vm, evaluation.error);
        evaluation.error.dispose();
        throw error;
      }
      const evaluatedPromise = evaluation.value;
      promiseHandle = evaluatedPromise;
      const guestResult = vm.resolvePromise(evaluatedPromise);
      // resolvePromise installs guest-side handlers. Run the resulting jobs
      // even when the async function completed without awaiting a host tool.
      settleJobs();
      const resolved = await Promise.race([
        guestResult,
        abortPromise(controller.signal),
      ]);
      if (resolved.error) {
        const error = dumpQuickJsError(vm, resolved.error);
        resolved.error.dispose();
        throw error;
      }
      resultHandle = resolved.value;
      const value: unknown = vm.dump(resultHandle);
      const serialized = serializeJson(value);
      if (Buffer.byteLength(serialized, "utf8") > limits.maxResultBytes) {
        throw new CodeExecutionBudgetError(
          `Final result exceeds ${limits.maxResultBytes} byte limit`,
        );
      }
      return {
        value,
        logs,
        toolCalls,
        durationMs: Date.now() - startedAtMs,
      };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === timeoutError) throw timeoutError;
      if (error instanceof Error) throw error;
      throw new CodeExecutionError(formatError(error));
    } finally {
      clearTimeout(timer);
      detachAbort();
      if (!controller.signal.aborted) controller.abort(new Error("Code execution completed"));
      await Promise.allSettled([...pending]);
      closed = true;
      resultHandle?.dispose();
      promiseHandle?.dispose();
      for (const deferred of deferreds) deferred.dispose();
      vm.dispose();
    }
  }
}

function buildBootstrap(
  tools: readonly { readonly id: string; readonly namespace: string; readonly name: string }[],
): string {
  return `
"use strict";
(() => {
  const call = globalThis.__codemode_call_tool;
  const log = globalThis.__codemode_log;
  const tools = Object.create(null);
  for (const item of ${JSON.stringify(tools)}) {
    const group = tools[item.namespace] ?? (tools[item.namespace] = Object.create(null));
    group[item.name] = (args = {}) => call(item.id, args);
  }
  for (const group of Object.values(tools)) Object.freeze(group);
  Object.freeze(tools);
  const safeSegments = path => {
    if (!Array.isArray(path) || path.some(segment =>
      segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
      throw new TypeError("Unsafe object path");
    }
    return path;
  };
  const codemode = Object.freeze({
    set(target, path, value) {
      const segments = safeSegments(path);
      let current = target;
      for (let index = 0; index < segments.length - 1; index++) {
        const segment = segments[index];
        const next = segments[index + 1];
        current = current[segment] ?? (current[segment] = typeof next === "number" ? [] : {});
      }
      current[segments.at(-1)] = value;
      return target;
    },
    normalizePath(value) { return String(value).replaceAll("\\\\", "/").replace(/\\/+/g, "/"); },
    dirname(value) {
      const normalized = this.normalizePath(value).replace(/\\/$/, "");
      const index = normalized.lastIndexOf("/");
      return index < 0 ? "." : normalized.slice(0, index) || "/";
    },
    basename(value) {
      const normalized = this.normalizePath(value).replace(/\\/$/, "");
      return normalized.slice(normalized.lastIndexOf("/") + 1);
    },
    joinPath(...parts) { return this.normalizePath(parts.filter(Boolean).join("/")); },
  });
  const console = Object.freeze({
    log: (...args) => log(...args),
    info: (...args) => log(...args),
    warn: (...args) => log(...args),
    error: (...args) => log(...args),
  });
  Object.defineProperties(globalThis, {
    tools: { value: tools, writable: false, configurable: false },
    codemode: { value: codemode, writable: false, configurable: false },
    console: { value: console, writable: false, configurable: false },
  });
  delete globalThis.__codemode_call_tool;
  delete globalThis.__codemode_log;
})();`;
}

function wrapCode(code: string): string {
  return `(async () => {\n"use strict";\n${code}\n})()`;
}

function jsonHandle(vm: QuickJSContext, serialized: string): QuickJSHandle {
  const result = vm.evalCode(`JSON.parse(${JSON.stringify(serialized)})`, "codemode-result.js");
  if (result.error) {
    const error = dumpQuickJsError(vm, result.error);
    result.error.dispose();
    throw error;
  }
  return result.value;
}

function dumpQuickJsError(vm: QuickJSContext, handle: QuickJSHandle): CodeExecutionError {
  const value: unknown = vm.dump(handle);
  const record = isRecord(value) ? value : undefined;
  const message = typeof record?.message === "string" ? record.message : safeDisplay(value);
  const stack = typeof record?.stack === "string" ? `\n${record.stack}` : "";
  return new CodeExecutionError(`${message}${stack}`);
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "null";
  return serialized;
}

function safeDisplay(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : safeDisplay(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  return signal.reason instanceof Error ? signal.reason : new CodeExecutionError("Code execution aborted");
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
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

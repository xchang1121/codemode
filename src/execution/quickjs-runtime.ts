import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import type {
  CodeBindingFunction,
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailureKind,
  CodeRunRequest,
  CodeRunResult,
  CodeRuntime,
} from "./code-runtime.js";
import { snapshotCodeJson } from "./code-runtime.js";

export interface QuickJsRuntimeOptions {
  readonly timeoutMs?: number;
  readonly memoryLimitBytes?: number;
  readonly maxStackBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxLogEntries?: number;
}

interface ResolvedQuickJsRuntimeOptions {
  readonly timeoutMs: number;
  readonly memoryLimitBytes: number;
  readonly maxStackBytes: number;
  readonly maxOutputBytes: number;
  readonly maxLogEntries: number;
}

interface CompiledBinding {
  readonly id: string;
  readonly invoke: CodeBindingFunction;
}

interface BootstrapMember {
  readonly id: string;
  readonly path: readonly string[];
  readonly memberName: string;
}

interface BootstrapNamespace {
  readonly global: string;
  readonly members: readonly BootstrapMember[];
  readonly errorClass?: { readonly name: string; readonly memberNameProperty: string };
}

const DEFAULT_OPTIONS: ResolvedQuickJsRuntimeOptions = {
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxLogEntries: 100,
};

const PORTABLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INVALID_OUTPUT_MARKER = "__CODEMODE_INVALID_OUTPUT__:";
const RESERVED_GLOBALS = new Set([
  "console",
  "globalThis",
  "Infinity",
  "NaN",
  "undefined",
  "eval",
  "__codemode_call_binding",
  "__codemode_log",
]);

/**
 * QuickJS/WASM implementation of the tool-agnostic CodeRuntime seam. It sees
 * only a program and async binding trees; all MCP dispatch stays in the caller.
 */
export class QuickJsCodeRuntime implements CodeRuntime {
  readonly language = "javascript";
  readonly isolation = "wasm";
  private readonly options: ResolvedQuickJsRuntimeOptions;

  constructor(options: QuickJsRuntimeOptions = {}) {
    this.options = normalizeOptions(options);
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    const compiled = compileBindings(request.bindings);
    const functions = new Map(compiled.functions.map((binding) => [binding.id, binding]));
    const runController = new AbortController();
    const detachAbort = relayAbort(request.signal, runController);
    const logs: string[] = [];
    let logBytes = 0;
    let outputLimitMessage: string | undefined;
    let timedOut = false;
    let closed = false;
    const pending = new Set<Promise<void>>();
    const deferreds = new Set<QuickJSDeferredPromise>();

    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();
    const deadline = Date.now() + this.options.timeoutMs;
    vm.runtime.setMemoryLimit(this.options.memoryLimitBytes);
    vm.runtime.setMaxStackSize(this.options.maxStackBytes);
    vm.runtime.setInterruptHandler(() => {
      if (runController.signal.aborted) return true;
      if (Date.now() < deadline) return false;
      timedOut = true;
      return true;
    });

    const settleJobs = (): void => {
      if (closed || !vm.alive || runController.signal.aborted) return;
      const jobs = vm.runtime.executePendingJobs();
      if (jobs.error) {
        const message = dumpQuickJsError(vm, jobs.error);
        jobs.error.dispose();
        runController.abort(new Error(message));
      }
    };

    const hostCall = vm.newFunction("__codemode_call_binding", (idHandle, argsHandle) => {
      const deferred = vm.newPromise();
      deferreds.add(deferred);
      const id = vm.getString(idHandle);
      const binding = functions.get(id);
      const dumped: unknown = vm.dump(argsHandle);
      const operation = (async () => {
        try {
          if (!binding) throw new Error(`Unknown code binding: ${id}`);
          const args = snapshotCodeJson(dumped, "binding arguments");
          const value = await binding.invoke(args, { signal: runController.signal });
          const serialized = serializeCodeJson(value, "binding result");
          if (closed) return;
          const handle = jsonHandle(vm, serialized);
          deferred.resolve(handle);
          handle.dispose();
        } catch (error) {
          if (closed) return;
          const errorHandle = vm.newError(formatError(error));
          deferred.reject(errorHandle);
          errorHandle.dispose();
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
    vm.setProp(vm.global, "__codemode_call_binding", hostCall);
    hostCall.dispose();

    const hostLog = vm.newFunction("__codemode_log", (...handles) => {
      if (logs.length >= this.options.maxLogEntries || outputLimitMessage) return vm.undefined;
      const values = handles.map((handle) => {
        const value: unknown = vm.dump(handle);
        return typeof value === "string" ? value : safeDisplay(value);
      });
      const line = values.join(" ");
      const bytes = Buffer.byteLength(line, "utf8");
      if (logBytes + bytes > this.options.maxOutputBytes) {
        outputLimitMessage = `Program output exceeds ${this.options.maxOutputBytes} byte limit`;
        return vm.undefined;
      }
      logs.push(line);
      logBytes += bytes;
      return vm.undefined;
    });
    vm.setProp(vm.global, "__codemode_log", hostLog);
    hostLog.dispose();

    let promiseHandle: QuickJSHandle | undefined;
    let resultHandle: QuickJSHandle | undefined;
    try {
      const bootstrap = buildBootstrap(compiled.namespaces);
      const evaluation = vm.evalCode(
        `${bootstrap}\n${wrapProgram(request.program)}`,
        "codemode-user.js",
      );
      if (evaluation.error) {
        const message = dumpQuickJsError(vm, evaluation.error);
        evaluation.error.dispose();
        return timedOut
          ? failure("timeout", `Code execution exceeded ${this.options.timeoutMs}ms timeout`, logs)
          : failure("exception", message, logs);
      }
      promiseHandle = evaluation.value;
      const guestResult = vm.resolvePromise(promiseHandle);
      settleJobs();
      const resolved = await Promise.race([
        guestResult,
        abortPromise(runController.signal),
      ]);
      if (resolved.error) {
        const message = dumpQuickJsError(vm, resolved.error);
        resolved.error.dispose();
        const invalidOutput = invalidOutputMessage(message);
        return timedOut
          ? failure("timeout", `Code execution exceeded ${this.options.timeoutMs}ms timeout`, logs)
          : runController.signal.aborted
          ? failure("abort", abortMessage(runController.signal), logs)
          : invalidOutput !== undefined
          ? failure("invalid-output", invalidOutput, logs)
          : failure("exception", message, logs);
      }
      resultHandle = resolved.value;
      if (outputLimitMessage) return failure("output-limit", outputLimitMessage, logs);
      const value: unknown = vm.dump(resultHandle);
      if (value === undefined) return { logs };
      let normalized: CodeJsonValue;
      let serialized: string;
      try {
        normalized = snapshotCodeJson(value, "program result");
        serialized = JSON.stringify(normalized);
      } catch (error) {
        return failure("invalid-output", errorMessage(error), logs);
      }
      if (logBytes + Buffer.byteLength(serialized, "utf8") > this.options.maxOutputBytes) {
        return failure(
          "output-limit",
          `Program output exceeds ${this.options.maxOutputBytes} byte limit`,
          logs,
        );
      }
      return { value: normalized, logs };
    } catch (error) {
      return timedOut
        ? failure("timeout", `Code execution exceeded ${this.options.timeoutMs}ms timeout`, logs)
        : runController.signal.aborted
        ? failure("abort", abortMessage(runController.signal), logs)
        : failure("exception", errorMessage(error), logs);
    } finally {
      // A program may launch a binding without awaiting it. End the entire run
      // scope together, abort those calls, and drain them before disposing WASM.
      if (!runController.signal.aborted) runController.abort(new Error("Code program settled"));
      closed = true;
      await Promise.allSettled([...pending]);
      resultHandle?.dispose();
      promiseHandle?.dispose();
      for (const deferred of deferreds) deferred.dispose();
      vm.dispose();
      detachAbort();
    }
  }
}

function compileBindings(bindings: readonly CodeBindingNamespace[]): {
  readonly functions: readonly CompiledBinding[];
  readonly namespaces: readonly BootstrapNamespace[];
} {
  const globals = new Set<string>();
  const errorClasses = new Map<string, string>();
  const functions: CompiledBinding[] = [];
  const namespaces: BootstrapNamespace[] = [];
  let sequence = 0;
  for (const namespace of bindings) {
    assertGlobalName(namespace.global, "binding namespace");
    if (globals.has(namespace.global)) {
      throw new TypeError(`Duplicate code binding namespace: ${namespace.global}`);
    }
    globals.add(namespace.global);
    if (namespace.errorClass) {
      assertGlobalName(namespace.errorClass.name, "binding error class");
      if (!namespace.errorClass.memberNameProperty) {
        throw new TypeError("Binding error memberNameProperty must not be empty");
      }
      const signature = JSON.stringify(namespace.errorClass);
      const existing = errorClasses.get(namespace.errorClass.name);
      if (existing !== undefined && existing !== signature) {
        throw new TypeError(`Conflicting code binding error class: ${namespace.errorClass.name}`);
      }
      errorClasses.set(namespace.errorClass.name, signature);
    }
    const trie: BindingPathNode = { children: new Map(), terminal: false };
    const members: BootstrapMember[] = [];
    for (const member of namespace.members) {
      validateBindingPath(member.path, namespace.global, trie);
      const id = `binding-${++sequence}`;
      functions.push({ id, invoke: member.invoke });
      members.push({
        id,
        path: [...member.path],
        memberName: [namespace.global, ...member.path].join("."),
      });
    }
    namespaces.push({
      global: namespace.global,
      members,
      ...(namespace.errorClass ? { errorClass: { ...namespace.errorClass } } : {}),
    });
  }
  return { functions, namespaces };
}

interface BindingPathNode {
  readonly children: Map<string, BindingPathNode>;
  terminal: boolean;
}

function validateBindingPath(
  path: readonly string[],
  global: string,
  root: BindingPathNode,
): void {
  if (path.length === 0 || path.some((segment) => typeof segment !== "string" || segment.length === 0)) {
    throw new TypeError(`Code binding below ${global} must have a non-empty string path`);
  }
  let node = root;
  for (const segment of path) {
    if (node.terminal) {
      throw new TypeError(`Code binding path conflicts below ${global}: ${path.join(".")}`);
    }
    let child = node.children.get(segment);
    if (!child) {
      child = { children: new Map(), terminal: false };
      node.children.set(segment, child);
    }
    node = child;
  }
  if (node.terminal || node.children.size > 0) {
    throw new TypeError(`Duplicate or conflicting code binding below ${global}: ${path.join(".")}`);
  }
  node.terminal = true;
}

function assertGlobalName(name: string, label: string): void {
  if (!PORTABLE_IDENTIFIER.test(name) || RESERVED_GLOBALS.has(name)) {
    throw new TypeError(`Invalid ${label} name: ${JSON.stringify(name)}`);
  }
}

function buildBootstrap(namespaces: readonly BootstrapNamespace[]): string {
  return `
"use strict";
(() => {
  const call = globalThis.__codemode_call_binding;
  const log = globalThis.__codemode_log;
  const define = (target, key, value) => Object.defineProperty(target, key, {
    value, enumerable: true, writable: false, configurable: false,
  });
  const errorClasses = Object.create(null);
  for (const namespace of ${JSON.stringify(namespaces)}) {
    let ErrorClass;
    if (namespace.errorClass) {
      ErrorClass = errorClasses[namespace.errorClass.name];
      if (!ErrorClass) {
        const config = namespace.errorClass;
        ErrorClass = class extends Error {
          constructor(memberName, message) {
            super(message);
            this.name = config.name;
            Object.defineProperty(this, config.memberNameProperty, {
              value: memberName, enumerable: true, writable: false, configurable: false,
            });
          }
        };
        errorClasses[config.name] = ErrorClass;
        Object.defineProperty(globalThis, config.name, {
          value: ErrorClass, writable: false, configurable: false,
        });
      }
    }
    const root = Object.create(null);
    const objects = [root];
    for (const member of namespace.members) {
      let current = root;
      for (let index = 0; index < member.path.length - 1; index++) {
        const segment = member.path[index];
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
          const child = Object.create(null);
          define(current, segment, child);
          objects.push(child);
        }
        current = current[segment];
      }
      const invoke = async (args = {}) => {
        try {
          return await call(member.id, args);
        } catch (error) {
          if (!ErrorClass) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new ErrorClass(member.memberName, message);
        }
      };
      define(current, member.path[member.path.length - 1], invoke);
    }
    for (let index = objects.length - 1; index >= 0; index--) Object.freeze(objects[index]);
    Object.defineProperty(globalThis, namespace.global, {
      value: root, writable: false, configurable: false,
    });
  }
  const console = Object.freeze({
    log: (...args) => log(...args),
    info: (...args) => log(...args),
    warn: (...args) => log(...args),
    error: (...args) => log(...args),
  });
  Object.defineProperty(globalThis, "console", {
    value: console, writable: false, configurable: false,
  });
  delete globalThis.__codemode_call_binding;
  delete globalThis.__codemode_log;
})();`;
}

function wrapProgram(program: string): string {
  return `(async () => {
  "use strict";
  const arrayIsArray = Array.isArray;
  const arrayPop = Array.prototype.pop;
  const arrayPush = Array.prototype.push;
  const numberIsFinite = Number.isFinite;
  const getPrototypeOf = Object.getPrototypeOf;
  const objectValues = Object.values;
  const objectPrototype = Object.prototype;
  const reflectApply = Reflect.apply;
  const SetConstructor = Set;
  const setAdd = Set.prototype.add;
  const setHas = Set.prototype.has;
  const value = await (async () => {
    "use strict";
${program}
  })();
  if (value === undefined) return value;
  const work = [value];
  const seen = new SetConstructor();
  while (work.length > 0) {
    const current = reflectApply(arrayPop, work, []);
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!numberIsFinite(current)) {
        throw new TypeError("${INVALID_OUTPUT_MARKER} program result must contain finite numbers");
      }
      continue;
    }
    if (typeof current !== "object") {
      throw new TypeError("${INVALID_OUTPUT_MARKER} program result must be lossless JSON");
    }
    if (reflectApply(setHas, seen, [current])) {
      throw new TypeError("${INVALID_OUTPUT_MARKER} program result must not contain cycles");
    }
    reflectApply(setAdd, seen, [current]);
    if (arrayIsArray(current)) {
      for (const item of current) reflectApply(arrayPush, work, [item]);
      continue;
    }
    const prototype = getPrototypeOf(current);
    if (prototype !== objectPrototype && prototype !== null) {
      throw new TypeError("${INVALID_OUTPUT_MARKER} program result must contain only JSON objects");
    }
    for (const item of objectValues(current)) reflectApply(arrayPush, work, [item]);
  }
  return value;
})()`;
}

function jsonHandle(vm: QuickJSContext, serialized: string): QuickJSHandle {
  const result = vm.evalCode(`JSON.parse(${JSON.stringify(serialized)})`, "codemode-binding.js");
  if (result.error) {
    const message = dumpQuickJsError(vm, result.error);
    result.error.dispose();
    throw new Error(message);
  }
  return result.value;
}

function dumpQuickJsError(vm: QuickJSContext, handle: QuickJSHandle): string {
  const value: unknown = vm.dump(handle);
  const record = isRecord(value) ? value : undefined;
  const message = typeof record?.message === "string" ? record.message : safeDisplay(value);
  const stack = typeof record?.stack === "string" ? `\n${record.stack}` : "";
  return `${message}${stack}`;
}

function serializeCodeJson(value: unknown, label: string): string {
  return JSON.stringify(snapshotCodeJson(value, label));
}

function failure(
  kind: CodeRunFailureKind,
  message: string,
  logs: readonly string[],
): CodeRunResult {
  return { logs: [...logs], error: { kind, message } };
}

function normalizeOptions(options: QuickJsRuntimeOptions): ResolvedQuickJsRuntimeOptions {
  return {
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_OPTIONS.timeoutMs),
    memoryLimitBytes: positiveInteger(options.memoryLimitBytes, DEFAULT_OPTIONS.memoryLimitBytes),
    maxStackBytes: positiveInteger(options.maxStackBytes, DEFAULT_OPTIONS.maxStackBytes),
    maxOutputBytes: positiveInteger(options.maxOutputBytes, DEFAULT_OPTIONS.maxOutputBytes),
    maxLogEntries: nonNegativeInteger(options.maxLogEntries, DEFAULT_OPTIONS.maxLogEntries),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
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

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Code run aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Code run aborted";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : safeDisplay(error);
}

function invalidOutputMessage(message: string): string | undefined {
  const start = message.indexOf(INVALID_OUTPUT_MARKER);
  if (start < 0) return undefined;
  return message.slice(start + INVALID_OUTPUT_MARKER.length).split("\n", 1)[0]?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

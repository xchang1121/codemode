/** A lossless JSON value that can cross a code-runtime boundary. */
export type CodeJsonValue =
  | null
  | boolean
  | number
  | string
  | CodeJsonValue[]
  | { [key: string]: CodeJsonValue };

/** Context owned by one program run and supplied to every host binding call. */
export interface CodeBindingCallContext {
  /** Aborts when the caller cancels the run or the program itself settles. */
  readonly signal: AbortSignal;
}

/** One host function callable by a model-written program. */
export type CodeBindingFunction = (
  args: unknown,
  context: CodeBindingCallContext,
) => Promise<CodeJsonValue>;

/** A function's path below its namespace global, for example `tools.docs.get`. */
export interface CodeBindingMember {
  readonly path: readonly string[];
  readonly invoke: CodeBindingFunction;
}

/** Optional typed rejection exposed inside the guest program. */
export interface CodeBindingErrorClass {
  readonly name: string;
  readonly memberNameProperty: string;
}

/**
 * A program-global tree of async host bindings. The runtime knows paths and
 * callables, but deliberately knows nothing about MCP, tools, sessions or policy.
 */
export interface CodeBindingNamespace {
  readonly global: string;
  readonly members: readonly CodeBindingMember[];
  readonly errorClass?: CodeBindingErrorClass;
}

/** Everything a runtime needs for one isolated, state-free program run. */
export interface CodeRunRequest {
  /** Body of an async function; top-level await and return are available. */
  readonly program: string;
  readonly bindings: readonly CodeBindingNamespace[];
  readonly signal?: AbortSignal;
}

export type CodeRunFailureKind =
  | "exception"
  | "timeout"
  | "abort"
  | "invalid-output"
  | "output-limit";

export interface CodeRunFailure {
  readonly kind: CodeRunFailureKind;
  readonly message: string;
}

/** Program failures are data; only misuse of the runtime contract rejects run(). */
export interface CodeRunResult {
  readonly value?: CodeJsonValue;
  readonly logs: readonly string[];
  readonly error?: CodeRunFailure;
}

/**
 * Substrate seam inspired by DSH's CodeRuntime: implementations execute code
 * against arbitrary host bindings and remain independent of the tool layer.
 */
export interface CodeRuntime {
  readonly language: string;
  readonly isolation: string;
  run(request: CodeRunRequest): Promise<CodeRunResult>;
}

/** Validate and detach one value at the runtime's lossless-JSON seam. */
export function snapshotCodeJson(value: unknown, label = "value"): CodeJsonValue {
  const work: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (work.length > 0) {
    const current = work.pop();
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${label} must contain finite numbers`);
      continue;
    }
    if (typeof current !== "object") {
      throw new TypeError(`${label} must be lossless JSON`);
    }
    if (seen.has(current)) throw new TypeError(`${label} must not contain cycles`);
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) work.push(item);
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only JSON objects`);
    }
    for (const item of Object.values(current as Record<string, unknown>)) work.push(item);
  }
  return JSON.parse(JSON.stringify(value)) as CodeJsonValue;
}

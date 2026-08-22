import type { ToolRegistry } from "../tools/tool-registry.js";
import { QuickJsCodeRuntime } from "./quickjs-runtime.js";
import { ToolScopeCodeExecutor } from "./tool-scope-executor.js";
import type { CodeExecutionLimits } from "./types.js";

/**
 * Backward-compatible convenience composition. QuickJS itself is now a pure
 * CodeRuntime; this class wires it to the repository's authoritative tool scope.
 */
export class QuickJsCodeExecutor extends ToolScopeCodeExecutor {
  constructor(
    registry: ToolRegistry,
    defaults: Partial<CodeExecutionLimits> = {},
  ) {
    super(
      registry,
      (limits) => new QuickJsCodeRuntime({
        timeoutMs: limits.timeoutMs,
        memoryLimitBytes: limits.memoryLimitBytes,
        maxStackBytes: limits.maxStackBytes,
        maxOutputBytes: limits.maxResultBytes,
        maxLogEntries: limits.maxLogEntries,
      }),
      defaults,
    );
  }
}

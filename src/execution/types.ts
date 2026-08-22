export interface CodeExecutionLimits {
  readonly timeoutMs: number;
  readonly perToolTimeoutMs: number;
  readonly memoryLimitBytes: number;
  readonly maxStackBytes: number;
  readonly maxCodeBytes: number;
  readonly maxToolCalls: number;
  readonly maxConcurrentToolCalls: number;
  readonly maxResultBytes: number;
  readonly maxLogEntries: number;
}

export const DEFAULT_CODE_EXECUTION_LIMITS: CodeExecutionLimits = {
  timeoutMs: 30_000,
  perToolTimeoutMs: 20_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
  maxCodeBytes: 64 * 1024,
  maxToolCalls: 32,
  maxConcurrentToolCalls: 8,
  maxResultBytes: 4 * 1024 * 1024,
  maxLogEntries: 100,
};

export interface CodeExecutionRequest {
  readonly code: string;
  readonly allowedTools: readonly string[];
  readonly sessionId: string;
  readonly description?: string;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<CodeExecutionLimits>;
}

export interface CodeExecutionResult {
  readonly value: unknown;
  readonly logs: readonly string[];
  readonly toolCalls: number;
  readonly durationMs: number;
}

export interface CodeExecutor {
  execute(request: CodeExecutionRequest): Promise<CodeExecutionResult>;
}

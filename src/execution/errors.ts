export class CodeExecutionError extends Error {
  override readonly name: string = "CodeExecutionError";
}

export class CodeExecutionTimeoutError extends CodeExecutionError {
  override readonly name: string = "CodeExecutionTimeoutError";

  constructor(timeoutMs: number) {
    super(`Code execution exceeded ${timeoutMs}ms timeout`);
  }
}

export class CodeExecutionBudgetError extends CodeExecutionError {
  override readonly name: string = "CodeExecutionBudgetError";
}

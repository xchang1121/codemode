export class UnknownToolError extends Error {
  override readonly name = "UnknownToolError";

  constructor(tool: string) {
    super(`Unknown tool: ${tool}`);
  }
}

export class ToolValidationError extends Error {
  override readonly name = "ToolValidationError";
  readonly tool: string;
  readonly phase: "input" | "output";
  readonly validationErrors: unknown;

  constructor(
    tool: string,
    phase: "input" | "output",
    validationErrors: unknown,
  ) {
    super(`Tool ${tool} returned invalid ${phase}: ${JSON.stringify(validationErrors)}`);
    this.tool = tool;
    this.phase = phase;
    this.validationErrors = validationErrors;
  }
}

export class ToolPolicyError extends Error {
  override readonly name = "ToolPolicyError";

  constructor(tool: string, reason?: string) {
    super(`Tool call denied: ${tool}${reason ? ` (${reason})` : ""}`);
  }
}

export class ToolTimeoutError extends Error {
  override readonly name = "ToolTimeoutError";

  constructor(tool: string, timeoutMs: number) {
    super(`Tool ${tool} exceeded ${timeoutMs}ms timeout`);
  }
}

export class ToolExecutionError extends Error {
  override readonly name = "ToolExecutionError";
  readonly result: import("./types.js").ToolResult;

  constructor(tool: string, result: import("./types.js").ToolResult) {
    super(`Tool ${tool} returned an error result`);
    this.result = result;
  }
}

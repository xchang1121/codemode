import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Stable MCP names for the complete model-visible Code Mode surface. */
export const CODE_MODE_TOOL_NAMES = {
  search: "codemode_search",
  describe: "codemode_describe",
  suggest: "codemode_suggest",
  execute: "codemode_execute",
} as const;

export type CodeModeToolName = (typeof CODE_MODE_TOOL_NAMES)[keyof typeof CODE_MODE_TOOL_NAMES];

/** Vendor extension used for Code Mode metadata on MCP results and tool definitions. */
export const CODE_MODE_META_KEY = "io.github.xchang1121/codemode";

/** Optional MCP request metadata field used to preserve learning context across calls. */
export const CODE_MODE_SESSION_META_KEY = "io.github.xchang1121/codemode-session";

/**
 * One source of truth for the model-facing protocol. Tool descriptions below
 * deliberately repeat only the details local to an individual operation.
 */
export const CODE_MODE_INSTRUCTIONS = [
  "This server exposes ordinary tools plus one Code Mode program transport.",
  "Use codemode_search and codemode_describe to discover the exact typed tool SDK.",
  "Use codemode_suggest to inspect learned multi-tool paths; copy a hint's allowedTools stable IDs exactly into codemode_execute.allowed_tools.",
  "Use codemode_execute for dependent calls, loops, branching, filtering or parallel calls.",
  "Its code is the body of one async JavaScript function: call tools with await tools[namespace][name](args), sequence dependent work with await, and use Promise.all only for independent work.",
  "Every codemode_execute request must include an explicit allowed_tools list; only values printed or returned by the program become its outer result.",
].join(" ");

export interface CodeModeSearchInput {
  readonly query: string;
  readonly limit: number;
}

export interface CodeModeDescribeInput {
  readonly names: readonly string[];
}

export interface CodeModeSuggestInput {
  readonly task: string;
  readonly limit: number;
}

export interface CodeModeExecuteInput {
  readonly description: string;
  readonly allowedTools: readonly string[];
  readonly code: string;
}

export type CodeModeRequest =
  | {
      readonly kind: "search";
      readonly name: typeof CODE_MODE_TOOL_NAMES.search;
      readonly input: CodeModeSearchInput;
    }
  | {
      readonly kind: "describe";
      readonly name: typeof CODE_MODE_TOOL_NAMES.describe;
      readonly input: CodeModeDescribeInput;
    }
  | {
      readonly kind: "suggest";
      readonly name: typeof CODE_MODE_TOOL_NAMES.suggest;
      readonly input: CodeModeSuggestInput;
    }
  | {
      readonly kind: "execute";
      readonly name: typeof CODE_MODE_TOOL_NAMES.execute;
      readonly input: CodeModeExecuteInput;
    };

const TOOL_DEFINITIONS: readonly Tool[] = [
  {
    name: CODE_MODE_TOOL_NAMES.search,
    description:
      "Search upstream tools and learned fusion paths without loading the full catalog. Call this before codemode_describe when the relevant tools are unknown.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Capability or task to search for" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: objectOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: CODE_MODE_TOOL_NAMES.describe,
    description:
      "Return exact input/output schemas, code references and TypeScript declarations for selected upstream tools.",
    inputSchema: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
      },
      required: ["names"],
      additionalProperties: false,
    },
    outputSchema: objectOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: CODE_MODE_TOOL_NAMES.suggest,
    description:
      "Show learned tool paths whose structured results can feed later tool arguments. Each hint includes an executable JavaScript skeleton and canonical allowedTools IDs.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Optional task text used to filter paths" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      },
      additionalProperties: false,
    },
    outputSchema: objectOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: CODE_MODE_TOOL_NAMES.execute,
    description: [
      "Execute the body of one async JavaScript function in an isolated QuickJS/WASM sandbox.",
      "Call tools as await tools[namespace][name](args); each call resolves to that tool's canonical JSON result.",
      "Sequence dependent work with await and use Promise.all for independent work.",
      "Only tools named in allowed_tools exist inside the program; a failed subcall rejects with ToolCallError, whose toolName identifies the binding.",
      "Only what the program prints or returns becomes outer output; intermediate values stay inside the run.",
      "No filesystem, process, environment or direct network APIs are available.",
      "Call codemode_search/codemode_describe first if exact tool schemas are not known.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          minLength: 1,
          description: "Short, non-empty summary of what the program does",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10_000,
          uniqueItems: true,
          description:
            "Explicit upstream stable IDs (prefer hint.allowedTools) or gateway names available to the program",
        },
        code: {
          type: "string",
          description: "JavaScript async-function body. Top-level await and return are supported.",
        },
      },
      required: ["description", "allowed_tools", "code"],
      additionalProperties: false,
    },
    outputSchema: objectOutputSchema(),
  },
];

/** Return detached definitions so callers cannot mutate the shared protocol. */
export function codeModeToolDefinitions(): Tool[] {
  return TOOL_DEFINITIONS.map((definition) => structuredClone(definition));
}

/**
 * Parse a known Code Mode request using the same limits published in its MCP
 * schema. Unknown names return undefined so an MCP adapter can try direct tools.
 */
export function parseCodeModeRequest(name: string, value: unknown): CodeModeRequest | undefined {
  if (!isCodeModeToolName(name)) return undefined;
  const args = asRecord(value) ?? {};
  switch (name) {
    case CODE_MODE_TOOL_NAMES.search:
      assertOnlyKeys(args, ["query", "limit"]);
      return {
        kind: "search",
        name,
        input: {
          query: stringArgument(args, "query"),
          limit: numberArgument(args.limit, 12, 1, 50),
        },
      };
    case CODE_MODE_TOOL_NAMES.describe:
      assertOnlyKeys(args, ["names"]);
      return {
        kind: "describe",
        name,
        input: { names: stringArrayArgument(args, "names", 1, 50, false) },
      };
    case CODE_MODE_TOOL_NAMES.suggest:
      assertOnlyKeys(args, ["task", "limit"]);
      return {
        kind: "suggest",
        name,
        input: {
          task: args.task === undefined ? "" : stringArgument(args, "task"),
          limit: numberArgument(args.limit, 5, 1, 20),
        },
      };
    case CODE_MODE_TOOL_NAMES.execute: {
      assertOnlyKeys(args, ["description", "allowed_tools", "code"]);
      const description = stringArgument(args, "description");
      if (description.trim().length === 0) {
        throw new TypeError("description must be a non-empty string");
      }
      return {
        kind: "execute",
        name,
        input: {
          description,
          allowedTools: stringArrayArgument(args, "allowed_tools", 1, 10_000, true),
          code: stringArgument(args, "code"),
        },
      };
    }
  }
}

export function isCodeModeToolName(name: string): name is CodeModeToolName {
  return Object.values(CODE_MODE_TOOL_NAMES).some((candidate) => candidate === name);
}

export function codeModeSessionId(sessionId: string | undefined, meta: unknown): string {
  const record = asRecord(meta);
  const supplied = record?.[CODE_MODE_SESSION_META_KEY];
  return typeof supplied === "string" && supplied ? supplied : sessionId ?? "default";
}

function objectOutputSchema(): Tool["outputSchema"] {
  return { type: "object", additionalProperties: true };
}

function numberArgument(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Expected an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function stringArgument(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

function stringArrayArgument(
  args: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
  unique: boolean,
): string[] {
  const value = args[key];
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new TypeError(`${key} must contain ${minimum}-${maximum} strings`);
  }
  const result = value as string[];
  if (unique && new Set(result).size !== result.length) {
    throw new TypeError(`${key} must not contain duplicates`);
  }
  return [...result];
}

function assertOnlyKeys(
  args: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new TypeError(`Unexpected argument: ${unexpected.join(", ")}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

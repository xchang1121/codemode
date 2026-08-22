import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { CodeExecutionLimits } from "./execution/types.js";
import type { HintDelivery } from "./gateway/code-mode-gateway.js";
import type { FusionLearnerSettings } from "./learning/fusion-learner.js";
import type { McpProviderConfig } from "./tools/mcp-provider.js";

export const DEFAULT_CONFIG_FILE = "codemode.config.json";

export interface ResolvedGatewayConfig {
  readonly exposeDirectTools: boolean;
  readonly hintDelivery: HintDelivery;
  readonly maxActiveHints: number;
  readonly name: string;
}

export interface ResolvedStateConfig {
  readonly path: string;
  readonly debounceMs: number;
  readonly maxStateBytes: number;
}

export interface ResolvedMcpServerConfig {
  readonly namespace: string;
  readonly provider: McpProviderConfig;
}

export interface ResolvedCodeModeConfig {
  readonly configPath: string;
  readonly servers: readonly ResolvedMcpServerConfig[];
  readonly gateway: ResolvedGatewayConfig;
  readonly execution: Partial<CodeExecutionLimits>;
  readonly learning: Partial<FusionLearnerSettings>;
  readonly state?: ResolvedStateConfig;
}

export interface ResolveConfigOptions {
  readonly configPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export class CodeModeConfigError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CodeModeConfigError";
  }
}

const stringMapSchema = z.record(z.string(), z.string());
const stdioServerSchema = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: stringMapSchema.optional(),
    maxBufferSize: z.number().int().positive().optional(),
  })
  .strict();
const httpServerSchema = z
  .object({
    transport: z.literal("http"),
    url: z.string().min(1),
    headers: stringMapSchema.optional(),
  })
  .strict();
const serverSchema = z.discriminatedUnion("transport", [stdioServerSchema, httpServerSchema]);
const probabilitySchema = z.number().min(0).max(1);
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const CodeModeConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).optional(),
    servers: z
      .record(z.string(), serverSchema)
      .refine((value) => Object.keys(value).length > 0, "At least one MCP server is required"),
    gateway: z
      .object({
        exposeDirectTools: z.boolean().optional(),
        hintDelivery: z.enum(["content", "meta", "both", "off"]).optional(),
        maxActiveHints: nonNegativeIntegerSchema.max(20).optional(),
        name: z.string().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    execution: z
      .object({
        timeoutMs: positiveIntegerSchema.optional(),
        perToolTimeoutMs: positiveIntegerSchema.optional(),
        memoryLimitBytes: positiveIntegerSchema.optional(),
        maxStackBytes: positiveIntegerSchema.optional(),
        maxCodeBytes: positiveIntegerSchema.optional(),
        maxToolCalls: positiveIntegerSchema.optional(),
        maxConcurrentToolCalls: positiveIntegerSchema.optional(),
        maxResultBytes: positiveIntegerSchema.optional(),
        maxLogEntries: nonNegativeIntegerSchema.optional(),
      })
      .strict()
      .optional(),
    learning: z
      .object({
        maxOrder: positiveIntegerSchema.optional(),
        minimumOccurrences: positiveIntegerSchema.optional(),
        minimumBindingReplayProbability: probabilitySchema.optional(),
        minimumConstantSupport: positiveIntegerSchema.optional(),
        decayHalfLifeEvents: positiveIntegerSchema.optional(),
        maxPatterns: positiveIntegerSchema.optional(),
        maxSamplesPerPool: positiveIntegerSchema.optional(),
        maxSessionEvents: positiveIntegerSchema.optional(),
        maxSuggestions: positiveIntegerSchema.optional(),
        beamWidthPerTool: positiveIntegerSchema.optional(),
        maxPathDepth: positiveIntegerSchema.optional(),
        maxEvidenceCandidatesPerPath: positiveIntegerSchema.optional(),
        maxPersistedEvidenceBytes: positiveIntegerSchema.optional(),
        persistBindingEvidence: z.boolean().optional(),
        learnCausalSubsequences: z.boolean().optional(),
        indexToolSuffixes: z.boolean().optional(),
      })
      .strict()
      .optional(),
    state: z
      .union([
        z.literal(false),
        z
          .object({
            path: z.string().min(1).optional(),
            debounceMs: nonNegativeIntegerSchema.optional(),
            maxStateBytes: positiveIntegerSchema.optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export async function loadCodeModeConfig(
  configPath = DEFAULT_CONFIG_FILE,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedCodeModeConfig> {
  const absolutePath = resolve(configPath);
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new CodeModeConfigError(`Cannot read config ${absolutePath}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new CodeModeConfigError(`Config ${absolutePath} is not valid JSON`, { cause: error });
  }
  return resolveCodeModeConfig(value, { configPath: absolutePath, environment });
}

export function resolveCodeModeConfig(
  value: unknown,
  options: ResolveConfigOptions = {},
): ResolvedCodeModeConfig {
  const configPath = resolve(options.configPath ?? DEFAULT_CONFIG_FILE);
  const environment = options.environment ?? process.env;
  const parsed = CodeModeConfigSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new CodeModeConfigError(`Invalid Code Mode config: ${details}`);
  }
  const baseDirectory = dirname(configPath);
  const servers = Object.entries(parsed.data.servers).map(
    ([namespace, server]): ResolvedMcpServerConfig => {
      validateNamespace(namespace);
      if (server.transport === "stdio") {
        const cwd = server.cwd
          ? resolveConfigPath(expandEnvironment(server.cwd, environment), baseDirectory)
          : undefined;
        return {
          namespace,
          provider: {
            transport: "stdio",
            command: expandEnvironment(server.command, environment),
            ...(server.args
              ? { args: server.args.map((item) => expandEnvironment(item, environment)) }
              : {}),
            ...(cwd ? { cwd } : {}),
            ...(server.env
              ? { env: expandStringMap(server.env, environment) }
              : {}),
            ...(server.maxBufferSize !== undefined
              ? { maxBufferSize: server.maxBufferSize }
              : {}),
          },
        };
      }
      const url = expandEnvironment(server.url, environment);
      validateHttpUrl(url, namespace);
      return {
        namespace,
        provider: {
          transport: "http",
          url,
          ...(server.headers
            ? { headers: expandStringMap(server.headers, environment) }
            : {}),
        },
      };
    },
  );

  const stateInput = parsed.data.state;
  const state = stateInput === false
    ? undefined
    : {
        path: resolveConfigPath(
          expandEnvironment(stateInput?.path ?? ".codemode/state.json", environment),
          baseDirectory,
        ),
        debounceMs: stateInput?.debounceMs ?? 500,
        maxStateBytes: stateInput?.maxStateBytes ?? 16 * 1024 * 1024,
      };
  return {
    configPath,
    servers,
    gateway: {
      exposeDirectTools: parsed.data.gateway?.exposeDirectTools ?? true,
      hintDelivery: parsed.data.gateway?.hintDelivery ?? "both",
      maxActiveHints: parsed.data.gateway?.maxActiveHints ?? 2,
      name: parsed.data.gateway?.name ?? "codemode-gateway",
    },
    execution: withoutUndefined(parsed.data.execution ?? {}),
    learning: withoutUndefined(parsed.data.learning ?? {}),
    ...(state ? { state } : {}),
  };
}

export function expandEnvironment(
  value: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined) {
      throw new CodeModeConfigError(`Environment variable ${name} is required by the config`);
    }
    return replacement;
  });
}

function expandStringMap(
  value: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandEnvironment(item, environment)]),
  );
}

type DefinedOptional<T> = {
  [Key in keyof T]?: Exclude<T[Key], undefined>;
};

function withoutUndefined<T extends Record<string, unknown>>(value: T): DefinedOptional<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as DefinedOptional<T>;
}

function resolveConfigPath(value: string, baseDirectory: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

function validateNamespace(namespace: string): void {
  if (!namespace || namespace.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(namespace)) {
    throw new CodeModeConfigError(
      `Invalid MCP namespace ${JSON.stringify(namespace)}; use 1-64 letters, numbers, '.', '_' or '-'`,
    );
  }
}

function validateHttpUrl(value: string, namespace: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CodeModeConfigError(`Invalid HTTP URL for ${namespace}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CodeModeConfigError(`HTTP MCP URL for ${namespace} must use http or https`);
  }
}

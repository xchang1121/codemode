import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { stableHash } from "../core/stable.js";
import {
  ToolPolicyError,
  ToolTimeoutError,
  ToolValidationError,
  UnknownToolError,
} from "./errors.js";
import type {
  RegisteredTool,
  ToolCallContext,
  ToolInvocationListener,
  ToolInvocationRequest,
  ToolPolicy,
  ToolProvider,
  ToolResult,
} from "./types.js";

export interface ToolRegistryOptions {
  readonly policy?: ToolPolicy;
}

export class ToolRegistry {
  private readonly providers = new Map<string, ToolProvider>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly gatewayNames = new Map<string, string>();
  private readonly listeners = new Set<ToolInvocationListener>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly policy: ToolPolicy;
  private readonly ajv: Ajv2020;

  constructor(options: ToolRegistryOptions = {}) {
    this.policy = options.policy ?? (() => ({ allowed: true }));
    this.ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    const addFormats = formatsModule.default as unknown as FormatsPlugin;
    addFormats(this.ajv);
  }

  async addProvider(provider: ToolProvider): Promise<readonly RegisteredTool[]> {
    validateNamespace(provider.namespace);
    if (this.providers.has(provider.namespace)) {
      throw new Error(`Duplicate tool provider namespace: ${provider.namespace}`);
    }
    await provider.connect?.();
    this.providers.set(provider.namespace, provider);
    try {
      return await this.refreshProvider(provider.namespace);
    } catch (error) {
      this.providers.delete(provider.namespace);
      await provider.close?.().catch(() => undefined);
      throw error;
    }
  }

  async refreshProvider(namespace: string): Promise<readonly RegisteredTool[]> {
    const provider = this.providers.get(namespace);
    if (!provider) throw new Error(`Unknown provider namespace: ${namespace}`);
    for (const [id, tool] of this.tools) {
      if (tool.namespace !== namespace) continue;
      this.tools.delete(id);
      this.gatewayNames.delete(tool.gatewayName);
    }
    const definitions = await provider.listTools();
    const registered: RegisteredTool[] = [];
    for (const definition of definitions) {
      if (!definition.name) continue;
      const id = toolId(namespace, definition.name);
      const gatewayName = uniqueGatewayName(
        gatewayToolName(namespace, definition.name),
        id,
        this.gatewayNames,
      );
      const tool: RegisteredTool = {
        id,
        namespace,
        originalName: definition.name,
        gatewayName,
        codeNamespace: namespace,
        codeName: definition.name,
        definition: structuredClone(definition),
        schemaHash: stableHash({
          inputSchema: definition.inputSchema,
          outputSchema: definition.outputSchema,
        }),
      };
      this.compileValidator(`${id}:input`, definition.inputSchema);
      if (definition.outputSchema) this.compileValidator(`${id}:output`, definition.outputSchema);
      this.tools.set(id, tool);
      this.gatewayNames.set(gatewayName, id);
      registered.push(tool);
    }
    return registered;
  }

  list(): readonly RegisteredTool[] {
    return [...this.tools.values()].sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) ||
        left.originalName.localeCompare(right.originalName),
    );
  }

  get(idOrGatewayName: string): RegisteredTool | undefined {
    return this.tools.get(idOrGatewayName) ?? this.tools.get(this.gatewayNames.get(idOrGatewayName) ?? "");
  }

  require(idOrGatewayName: string): RegisteredTool {
    const tool = this.get(idOrGatewayName);
    if (!tool) throw new UnknownToolError(idOrGatewayName);
    return tool;
  }

  search(query: string, limit = 20): readonly RegisteredTool[] {
    const terms = tokenize(query);
    return this.list()
      .map((tool) => ({ tool, score: searchScore(tool, terms) }))
      .filter((item) => item.score > 0 || terms.length === 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.tool.id.localeCompare(right.tool.id),
      )
      .slice(0, Math.max(1, Math.floor(limit)))
      .map((item) => item.tool);
  }

  onInvocation(listener: ToolInvocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async call(
    idOrGatewayName: string,
    args: Readonly<Record<string, unknown>>,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const tool = this.require(idOrGatewayName);
    const provider = this.providers.get(tool.namespace);
    if (!provider) throw new Error(`Provider ${tool.namespace} is not connected`);
    const inputValidator = this.validators.get(`${tool.id}:input`);
    if (inputValidator && !inputValidator(args)) {
      throw new ToolValidationError(tool.id, "input", inputValidator.errors);
    }
    const request: ToolInvocationRequest = { tool, args, context };
    const decision = await this.policy(request);
    if (!decision.allowed) throw new ToolPolicyError(tool.id, decision.reason);

    const startedAtMs = Date.now();
    const controller = new AbortController();
    const detach = relayAbort(context.signal, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = context.timeoutMs;
    const call = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw signalReason(controller.signal);
      return provider.callTool(tool.originalName, args, {
        signal: controller.signal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    });
    const guards: Array<Promise<ToolResult>> = [call];
    if (timeoutMs !== undefined && timeoutMs > 0) {
      guards.push(
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new ToolTimeoutError(tool.id, timeoutMs);
            controller.abort(error);
            reject(error);
          }, timeoutMs);
          timer.unref?.();
        }),
      );
    }
    guards.push(abortRejection(controller.signal));
    const guarded = Promise.race(guards);
    try {
      const result = await guarded;
      if (tool.definition.outputSchema && result.structuredContent === undefined) {
        throw new ToolValidationError(tool.id, "output", [
          { message: "structuredContent is required when outputSchema is declared" },
        ]);
      }
      if (result.structuredContent !== undefined && tool.definition.outputSchema) {
        const outputValidator = this.validators.get(`${tool.id}:output`);
        if (outputValidator && !outputValidator(result.structuredContent)) {
          throw new ToolValidationError(tool.id, "output", outputValidator.errors);
        }
      }
      this.emit({
        ...request,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        result,
      });
      return result;
    } catch (error) {
      this.emit({
        ...request,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        error,
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      detach();
    }
  }

  codeReference(idOrGatewayName: string): string {
    const tool = this.require(idOrGatewayName);
    return `tools[${JSON.stringify(tool.codeNamespace)}][${JSON.stringify(tool.codeName)}]`;
  }

  schemaHashes(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.list().map((tool) => [tool.id, tool.schemaHash]));
  }

  async close(): Promise<void> {
    const providers = [...this.providers.values()];
    this.providers.clear();
    this.tools.clear();
    this.gatewayNames.clear();
    await Promise.allSettled(providers.map((provider) => provider.close?.()));
  }

  private compileValidator(key: string, schema: object): void {
    try {
      this.validators.set(key, this.ajv.compile(schema));
    } catch (error) {
      throw new Error(`Invalid JSON Schema for ${key}`, { cause: error });
    }
  }

  private emit(trace: Parameters<ToolInvocationListener>[0]): void {
    for (const listener of this.listeners) {
      try {
        listener(trace);
      } catch {
        // Observation must never change authoritative tool behavior.
      }
    }
  }
}

export function toolResultValue(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return structuredClone(result.structuredContent);
  return {
    content: structuredClone(result.content),
    isError: result.isError === true,
  };
}

export function toolId(namespace: string, originalName: string): string {
  return `${namespace}::${originalName}`;
}

function gatewayToolName(namespace: string, originalName: string): string {
  return `${safeName(namespace)}__${safeName(originalName)}`.slice(0, 100);
}

function uniqueGatewayName(
  preferred: string,
  id: string,
  existing: ReadonlyMap<string, string>,
): string {
  if (!existing.has(preferred) || existing.get(preferred) === id) return preferred;
  const suffix = stableHash(id).slice(0, 8);
  return `${preferred.slice(0, Math.max(1, 91 - suffix.length))}_${suffix}`;
}

function safeName(value: string): string {
  const result = value.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
  return result || "tool";
}

function validateNamespace(namespace: string): void {
  if (!namespace || namespace.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(namespace)) {
    throw new Error(
      `Invalid provider namespace ${JSON.stringify(namespace)}; use 1-64 letters, numbers, '.', '_' or '-'`,
    );
  }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);
}

function searchScore(tool: RegisteredTool, terms: readonly string[]): number {
  const name = `${tool.namespace} ${tool.originalName}`.toLowerCase();
  const description = (tool.definition.description ?? "").toLowerCase();
  return terms.reduce((score, term) => {
    if (name === term) return score + 20;
    if (name.includes(term)) return score + 8;
    if (description.includes(term)) return score + 2;
    return score;
  }, 0);
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

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(signalReason(signal));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Tool call aborted");
}

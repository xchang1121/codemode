import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { QuickJsCodeExecutor } from "./execution/quickjs-executor.js";
import { CodeModeGateway } from "./gateway/code-mode-gateway.js";
import { FusionLearner } from "./learning/fusion-learner.js";
import { FusionStateAutosave } from "./persistence/fusion-state-autosave.js";
import {
  FusionStateStore,
  type FusionStateLoadResult,
} from "./persistence/fusion-state-store.js";
import { McpToolProvider } from "./tools/mcp-provider.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import type { ResolvedCodeModeConfig } from "./config.js";

export interface CreateCodeModeRuntimeOptions {
  readonly onPersistenceError?: (error: unknown) => void;
}

export interface CodeModeRuntime {
  readonly config: ResolvedCodeModeConfig;
  readonly registry: ToolRegistry;
  readonly learner: FusionLearner;
  readonly gateway: CodeModeGateway;
  readonly stateLoadResult?: FusionStateLoadResult;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export async function createCodeModeRuntime(
  config: ResolvedCodeModeConfig,
  options: CreateCodeModeRuntimeOptions = {},
): Promise<CodeModeRuntime> {
  const registry = new ToolRegistry();
  try {
    for (const server of config.servers) {
      await registry.addProvider(new McpToolProvider(server.namespace, server.provider));
    }
  } catch (error) {
    await registry.close();
    throw error;
  }

  const learner = new FusionLearner(config.learning);
  let stateLoadResult: FusionStateLoadResult | undefined;
  let autosave: FusionStateAutosave | undefined;
  if (config.state) {
    const store = new FusionStateStore(config.state.path, {
      maxStateBytes: config.state.maxStateBytes,
    });
    try {
      stateLoadResult = await store.load(learner);
    } catch (error) {
      await registry.close();
      throw error;
    }
    autosave = new FusionStateAutosave(store, learner, {
      debounceMs: config.state.debounceMs,
      ...(options.onPersistenceError ? { onError: options.onPersistenceError } : {}),
    });
  }

  const gateway = new CodeModeGateway({
    registry,
    learner,
    executor: new QuickJsCodeExecutor(registry, config.execution),
    exposeDirectTools: config.gateway.exposeDirectTools,
    hintDelivery: config.gateway.hintDelivery,
    maxActiveHints: config.gateway.maxActiveHints,
    name: config.gateway.name,
    ...(autosave ? { onLearnerChanged: () => autosave.schedule() } : {}),
  });
  let closed = false;
  return {
    config,
    registry,
    learner,
    gateway,
    ...(stateLoadResult ? { stateLoadResult } : {}),
    connect: (transport) => gateway.connect(transport),
    close: async () => {
      if (closed) return;
      closed = true;
      // Stop accepting observations before the final state flush so an
      // in-flight callback cannot be lost after autosave enters its closed state.
      const results: PromiseSettledResult<void>[] = [];
      results.push(await settle(gateway.close()));
      if (autosave) results.push(await settle(autosave.close()));
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason as unknown);
      if (errors.length) throw new AggregateError(errors, "Failed to close Code Mode runtime");
    },
  };
}

async function settle(operation: Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await operation;
    return { status: "fulfilled", value: undefined };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

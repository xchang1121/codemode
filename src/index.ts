export {
  FUSION_LEARNER_DEFAULTS,
  FusionLearner,
  eventToken,
  type FusionLearnerSettings,
} from "./learning/fusion-learner.js";
export {
  applyBindingsPartial,
  bindingDependencies,
  decodePath,
  encodePath,
  formatPath,
  inferStableBindings,
  type BindingInferenceOptions,
  type BindingSample,
} from "./learning/bindings.js";
export {
  PpmCountTrie,
  type PpmCountTrieRow,
  type PpmProbabilityEstimate,
} from "./learning/ppm-count-trie.js";
export { SuffixPatternTrie } from "./learning/suffix-pattern-trie.js";
export type {
  BindingSource,
  FusionCandidate,
  FusionDependency,
  FusionLearnerSnapshot,
  FusionPath,
  FusionPathStep,
  LearnedBindingSet,
  LearnedToolPattern,
  ToolEvent,
  ToolObservation,
  ToolOutcome,
  ValueBinding,
  ValuePath,
} from "./learning/types.js";
export {
  CodeModeGateway,
  type CodeModeGatewayOptions,
  type HintDelivery,
} from "./gateway/code-mode-gateway.js";
export {
  fusionHintText,
  renderFusionHints,
  renderFusionPathCode,
  type RenderedFusionHint,
} from "./hints/fusion-hints.js";
export { QuickJsCodeExecutor } from "./execution/quickjs-executor.js";
export {
  DEFAULT_CODE_EXECUTION_LIMITS,
  type CodeExecutionLimits,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeExecutor,
} from "./execution/types.js";
export {
  CodeExecutionBudgetError,
  CodeExecutionError,
  CodeExecutionTimeoutError,
} from "./execution/errors.js";
export {
  InMemoryToolProvider,
  type InMemoryTool,
  type InMemoryToolHandler,
} from "./tools/in-memory-provider.js";
export {
  McpToolProvider,
  type HttpMcpProviderConfig,
  type McpProviderConfig,
  type StdioMcpProviderConfig,
} from "./tools/mcp-provider.js";
export {
  ToolRegistry,
  toolId,
  toolResultValue,
  type ToolRegistryOptions,
} from "./tools/tool-registry.js";
export {
  renderToolDeclaration,
  renderToolSdk,
  schemaToTypeScript,
  toolCodeReference,
} from "./tools/schema-to-typescript.js";
export {
  ToolExecutionError,
  ToolPolicyError,
  ToolTimeoutError,
  ToolValidationError,
  UnknownToolError,
} from "./tools/errors.js";
export type {
  RegisteredTool,
  ToolCallContext,
  ToolCallSource,
  ToolDefinition,
  ToolInvocationListener,
  ToolInvocationRequest,
  ToolInvocationTrace,
  ToolPolicy,
  ToolPolicyDecision,
  ToolProvider,
  ToolProviderCallContext,
  ToolResult,
} from "./tools/types.js";

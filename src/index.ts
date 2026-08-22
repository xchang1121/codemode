export {
  FUSION_LEARNER_DEFAULTS,
  FusionLearner,
  eventToken,
  type FusionLearnerSettings,
} from "./learning/fusion-learner.js";
export {
  applyBindingsPartial,
  bindingEvidenceHasOutputDependency,
  bindingDependencies,
  bindingFingerprint,
  captureBindingEvidence,
  decodePath,
  encodePath,
  formatPath,
  inferStableBindings,
  inferStableBindingsFromEvidence,
  type BindingEvidenceCandidate,
  type BindingEvidenceCapture,
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
  BindingObservationEvidence,
  BindingPathEvidence,
  BindingSource,
  FusionCandidate,
  FusionDependency,
  FusionLearnerSnapshot,
  FusionLearnerSnapshotV1,
  FusionLearnerSnapshotV2,
  FusionPatternPoolSnapshot,
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
  CODE_MODE_INSTRUCTIONS,
  CODE_MODE_META_KEY,
  CODE_MODE_SESSION_META_KEY,
  CODE_MODE_TOOL_NAMES,
  codeModeSessionId,
  codeModeToolDefinitions,
  isCodeModeToolName,
  parseCodeModeRequest,
  type CodeModeDescribeInput,
  type CodeModeExecuteInput,
  type CodeModeRequest,
  type CodeModeSearchInput,
  type CodeModeSuggestInput,
  type CodeModeToolName,
} from "./code-mode/contract.js";
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
export {
  CodeModeConfigError,
  CodeModeConfigSchema,
  DEFAULT_CONFIG_FILE,
  expandEnvironment,
  loadCodeModeConfig,
  resolveCodeModeConfig,
  type ResolveConfigOptions,
  type ResolvedCodeModeConfig,
  type ResolvedGatewayConfig,
  type ResolvedMcpServerConfig,
  type ResolvedStateConfig,
} from "./config.js";
export {
  FusionStateStore,
  type FusionStateLoadResult,
  type FusionStateStoreOptions,
} from "./persistence/fusion-state-store.js";
export {
  FusionStateAutosave,
  type FusionStateAutosaveOptions,
} from "./persistence/fusion-state-autosave.js";
export {
  createCodeModeRuntime,
  type CodeModeRuntime,
  type CreateCodeModeRuntimeOptions,
} from "./runtime.js";
export { CODEMODE_VERSION } from "./version.js";

import type { CodeExecutor } from "../execution/types.js";
import {
  FusionAdvisor,
} from "../hints/fusion-advisor.js";
import { FusionLearner } from "../learning/fusion-learner.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import {
  CodeModeService,
  type CodeModeApplicationPort,
} from "./service.js";
import type { HintDelivery } from "./ports.js";

export type { HintDelivery } from "./ports.js";

export interface DefaultCodeModeApplicationOptions {
  readonly registry: ToolRegistry;
  readonly executor: CodeExecutor;
  readonly learner?: FusionLearner;
  readonly exposeDirectTools?: boolean;
  readonly hintDelivery?: HintDelivery;
  readonly maxActiveHints?: number;
  /** Runs after authoritative observations update the learner. */
  readonly onLearnerChanged?: (learner: FusionLearner) => void;
}

export interface DefaultCodeModeApplication {
  readonly application: CodeModeApplicationPort;
  readonly learner: FusionLearner;
}

/** Concrete composition kept outside both the MCP adapter and application service. */
export function createDefaultCodeModeApplication(
  options: DefaultCodeModeApplicationOptions,
): DefaultCodeModeApplication {
  const advisor = new FusionAdvisor({
    registry: options.registry,
    ...(options.learner ? { learner: options.learner } : {}),
    ...(options.hintDelivery ? { hintDelivery: options.hintDelivery } : {}),
    ...(options.maxActiveHints !== undefined
      ? { maxActiveHints: options.maxActiveHints }
      : {}),
    ...(options.onLearnerChanged
      ? { onLearnerChanged: options.onLearnerChanged }
      : {}),
  });
  return {
    learner: advisor.learner,
    application: new CodeModeService({
      registry: options.registry,
      executor: options.executor,
      advisor,
      ...(options.exposeDirectTools !== undefined
        ? { exposeDirectTools: options.exposeDirectTools }
        : {}),
      closeRegistry: true,
    }),
  };
}

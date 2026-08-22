import { decodePath } from "../learning/bindings.js";
import type {
  FusionPath,
  FusionPathStep,
  ValueBinding,
  ValuePath,
} from "../learning/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

export interface RenderedFusionHint {
  readonly tools: readonly string[];
  readonly probability: number;
  readonly dataflowEdges: number;
  readonly summary: string;
  readonly code: string;
}

interface AvailableStep {
  readonly inputVariable: string;
  readonly resultVariable: string;
}

export function renderFusionHints(
  paths: readonly FusionPath[],
  registry: ToolRegistry,
  limit = 3,
): readonly RenderedFusionHint[] {
  return paths.slice(0, Math.max(0, Math.floor(limit))).map((path) => {
    const tools = path.tools.map((tool) => displayTool(tool, registry));
    return {
      tools,
      probability: path.probability,
      dataflowEdges: path.dataflowEdges,
      summary: `${tools.join(" → ")} (${formatProbability(path.probability)}, ${path.dataflowEdges} learned data-flow ${path.dataflowEdges === 1 ? "edge" : "edges"})`,
      code: renderFusionPathCode(path, registry),
    };
  });
}

export function renderFusionPathCode(path: FusionPath, registry: ToolRegistry): string {
  const lines: string[] = [];
  const available: AvailableStep[] = [];
  const firstStep = path.steps[0];
  const requiredContext = firstStep
    ? Math.max(1, maximumRelativeDepth(firstStep))
    : Math.max(1, path.contextTools.length);
  const contextTools = path.contextTools.slice(-requiredContext);

  for (const toolId of contextTools) {
    const index = available.length + 1;
    const inputVariable = `input${index}`;
    const resultVariable = `step${index}`;
    lines.push(`const ${inputVariable} = { /* fill task-specific input */ };`);
    lines.push(
      `const ${resultVariable} = await ${codeReference(toolId, registry)}(${inputVariable});`,
    );
    available.push({ inputVariable, resultVariable });
  }

  for (const step of path.steps) {
    const index = available.length + 1;
    const inputVariable = `input${index}`;
    const resultVariable = `step${index}`;
    lines.push(`const ${inputVariable} = {};`);
    for (const [encodedPath, binding] of Object.entries(step.bindings).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const targetPath = decodePath(encodedPath);
      lines.push(
        `codemode.set(${inputVariable}, ${JSON.stringify(targetPath)}, ${renderBinding(binding, available)});`,
      );
    }
    for (const missing of step.missing) {
      lines.push(
        `// TODO: set ${inputVariable}${accessPath(missing)} from the current task.`,
      );
    }
    lines.push(
      `const ${resultVariable} = await ${codeReference(step.tool, registry)}(${inputVariable});`,
    );
    available.push({ inputVariable, resultVariable });
  }
  const final = available.at(-1)?.resultVariable ?? "undefined";
  lines.push(`return ${final};`);
  return lines.join("\n");
}

export function fusionHintText(hints: readonly RenderedFusionHint[]): string {
  if (!hints.length) return "";
  const lines = [
    "[Code Mode fusion hint]",
    "Repeated authoritative calls suggest these tools can be fused for similar tasks:",
  ];
  for (const [index, hint] of hints.entries()) {
    lines.push(`${index + 1}. ${hint.summary}`);
    lines.push("```js", hint.code, "```");
  }
  lines.push(
    "Use codemode_execute before issuing the separate calls when this path matches the current task.",
  );
  return lines.join("\n");
}

function renderBinding(binding: ValueBinding, available: readonly AvailableStep[]): string {
  if (binding.type === "constant") return jsonLiteral(binding.value);
  if (binding.type === "event") {
    const index = available.length + binding.relativeEvent;
    const source = available[index];
    if (!source) return "undefined /* unavailable learned source */";
    const root = binding.field === "output" ? source.resultVariable : source.inputVariable;
    return `${root}${accessPath(binding.path)}`;
  }
  if (binding.type === "template") {
    return `${JSON.stringify(binding.prefix)} + String(${renderBinding(binding.source, available)}) + ${JSON.stringify(binding.suffix)}`;
  }
  if (binding.type === "transform") {
    const operation =
      binding.operation === "normalize_path"
        ? "normalizePath"
        : binding.operation;
    return `codemode.${operation}(${renderBinding(binding.source, available)})`;
  }
  return `codemode.joinPath(${renderBinding(binding.left, available)}, ${renderBinding(binding.right, available)})`;
}

function maximumRelativeDepth(step: FusionPathStep): number {
  return step.dependencies.reduce(
    (maximum, dependency) =>
      Math.max(
        maximum,
        ...dependency.sources.map((source) => Math.abs(source.relativeEvent)),
      ),
    0,
  );
}

function codeReference(id: string, registry: ToolRegistry): string {
  const tool = registry.get(id);
  return tool ? registry.codeReference(id) : `tools[${JSON.stringify(id)}]`;
}

function displayTool(id: string, registry: ToolRegistry): string {
  const tool = registry.get(id);
  return tool ? `${tool.namespace}.${tool.originalName}` : id.replace("::", ".");
}

function accessPath(path: ValuePath): string {
  return path.map((segment) => `[${JSON.stringify(segment)}]`).join("");
}

function jsonLiteral(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

function formatProbability(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}% confidence`;
}

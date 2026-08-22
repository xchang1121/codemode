import path from "node:path";
import { stableStringify } from "../core/stable.js";
import type {
  BindingSource,
  FusionDependency,
  LearnedBindingSet,
  ToolEvent,
  ValueBinding,
  ValuePath,
} from "./types.js";

const MISSING = Symbol("missing");
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_SEGMENTS = [
  "authorization",
  "credential",
  "cookie",
  "password",
  "privatekey",
  "secret",
  "token",
  "apikey",
];

export interface BindingSample {
  readonly context: readonly ToolEvent[];
  readonly target: ToolEvent;
}

export interface BindingInferenceOptions {
  readonly minimumReplayProbability: number;
  readonly minimumConstantSupport: number;
}

export function inferStableBindings(
  samples: readonly BindingSample[],
  options: BindingInferenceOptions,
): LearnedBindingSet {
  if (!samples.length) return { bindings: {}, missing: [], replayProbability: 0 };
  const bindings: Record<string, ValueBinding> = {};
  const missing: ValuePath[] = [];
  let replayMatches = 0;
  let replayOpportunities = 0;
  const targetPaths = new Map<string, ValuePath>();
  for (const sample of samples) {
    for (const [targetPath] of leaves(sample.target.input)) {
      if (targetPath.length === 0) continue;
      targetPaths.set(encodePath(targetPath), targetPath);
    }
  }

  for (const [encodedPath, targetPath] of [...targetPaths].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const targets = samples.map((sample) => getPath(sample.target.input, targetPath));
    if (targets.some((value) => value === MISSING) || isSecretPath(targetPath)) {
      missing.push(targetPath);
      continue;
    }

    const candidates = uniqueBindings(
      samples.flatMap((sample, index) =>
        candidateBindings(sample.context, targets[index], targetPath),
      ),
    );
    let selected: ValueBinding | undefined;
    let selectedMatches = -1;
    let selectedComplexity = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const matches = samples.reduce(
        (count, sample, index) =>
          count + Number(sameValue(evaluateBinding(candidate, sample.context), targets[index])),
        0,
      );
      const complexity = bindingComplexity(candidate);
      if (
        matches > selectedMatches ||
        (matches === selectedMatches && complexity < selectedComplexity)
      ) {
        selected = candidate;
        selectedMatches = matches;
        selectedComplexity = complexity;
      }
    }

    const candidateReplay = selectedMatches / samples.length;
    if (selected && candidateReplay < options.minimumReplayProbability) {
      selected = undefined;
    }
    if (!selected) {
      const first = targets[0];
      const stableConstant = targets.every((value) => sameValue(value, first));
      const sessions = new Set(samples.map((sample) => sample.target.sessionId));
      if (
        stableConstant &&
        (!requiresProvenance(targetPath, first) ||
          sessions.size >= options.minimumConstantSupport)
      ) {
        selected = { type: "constant", value: structuredClone(first) };
        selectedMatches = samples.length;
      }
    }

    if (!selected) {
      missing.push(targetPath);
      continue;
    }
    bindings[encodedPath] = selected;
    replayMatches += Math.max(0, selectedMatches);
    replayOpportunities += samples.length;
  }

  return {
    bindings,
    missing,
    replayProbability:
      replayOpportunities > 0 ? replayMatches / replayOpportunities : 0,
  };
}

export function applyBindingsPartial(
  bindings: Readonly<Record<string, ValueBinding>>,
  context: readonly ToolEvent[],
  knownMissing: readonly ValuePath[] = [],
): { readonly input: Readonly<Record<string, unknown>>; readonly missing: readonly ValuePath[] } {
  let input: Readonly<Record<string, unknown>> = {};
  const missing = knownMissing.map((value) => [...value]);
  for (const [encodedPath, binding] of Object.entries(bindings)) {
    const targetPath = decodePath(encodedPath);
    const value = evaluateBinding(binding, context);
    if (value === MISSING) {
      missing.push(targetPath);
      continue;
    }
    const next = withPath(input, targetPath, value);
    if (!next) missing.push(targetPath);
    else input = next;
  }
  return { input, missing: uniquePaths(missing) };
}

export function bindingDependencies(
  bindings: Readonly<Record<string, ValueBinding>>,
): readonly FusionDependency[] {
  return Object.entries(bindings).flatMap(([encodedPath, binding]) => {
    const sources = uniqueSources(bindingSources(binding));
    return sources.length
      ? [{ targetPath: decodePath(encodedPath), sources }]
      : [];
  });
}

export function encodePath(value: ValuePath): string {
  return JSON.stringify(value);
}

export function decodePath(value: string): Array<string | number> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isValuePath(parsed) ? [...parsed] : [];
  } catch {
    return [];
  }
}

export function formatPath(value: ValuePath): string {
  return value
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : /^[A-Za-z_$][\w$]*$/.test(segment)
          ? `${index === 0 ? "" : "."}${segment}`
          : `[${JSON.stringify(segment)}]`,
    )
    .join("");
}

function candidateBindings(
  context: readonly ToolEvent[],
  target: unknown,
  targetPath: ValuePath,
): ValueBinding[] {
  const result: ValueBinding[] = [];
  const targetIsPath = isPathField(String(targetPath.at(-1) ?? ""));
  const pathSources: Array<{ readonly binding: ValueBinding; readonly value: string }> = [];

  for (let index = context.length - 1; index >= 0; index--) {
    const event = context[index];
    if (!event) continue;
    const relativeEvent = index - context.length;
    const fields = [
      ["output", event.output],
      ["input", event.input],
    ] as const;
    for (const [field, fieldValue] of fields) {
      for (const [sourcePath, source] of leaves(fieldValue)) {
        if (sourcePath.length === 0) continue;
        if (isSecretPath(sourcePath)) continue;
        const direct: ValueBinding = { type: "event", relativeEvent, field, path: sourcePath };
        const pathSource = typeof source === "string" && isPathSource(field, sourcePath, source);
        if (sameValue(source, target) && (!targetIsPath || pathSource)) result.push(direct);
        if (typeof source !== "string" || typeof target !== "string") continue;

        const variants: Array<{ readonly binding: ValueBinding; readonly value: string }> = [
          { binding: direct, value: source },
        ];
        if (pathSource) {
          pathSources.push({ binding: direct, value: source });
          for (const operation of ["dirname", "basename", "normalize_path"] as const) {
            const transformed: ValueBinding = { type: "transform", operation, source: direct };
            const transformedValue = transform(operation, source);
            variants.push({ binding: transformed, value: transformedValue });
            pathSources.push({ binding: transformed, value: transformedValue });
            if (transformedValue === target) result.push(transformed);
          }
        }
        if (targetIsPath && !pathSource) continue;
        for (const variant of variants) {
          if (variant.value.length < 3) continue;
          const offset = target.indexOf(variant.value);
          if (offset < 0) continue;
          result.push({
            type: "template",
            source: variant.binding,
            prefix: target.slice(0, offset),
            suffix: target.slice(offset + variant.value.length),
          });
        }
      }
    }
  }

  if (targetIsPath && typeof target === "string") {
    const normalizedTarget = normalizePath(target);
    for (const left of uniquePathSources(pathSources)) {
      for (const right of uniquePathSources(pathSources)) {
        if (left === right) continue;
        if (normalizePath(path.join(left.value, right.value)) !== normalizedTarget) continue;
        result.push({
          type: "join",
          operation: "join_path",
          left: left.binding,
          right: right.binding,
        });
      }
    }
  }
  return uniqueBindings(result);
}

function evaluateBinding(binding: ValueBinding, context: readonly ToolEvent[]): unknown {
  if (binding.type === "constant") return structuredClone(binding.value);
  if (binding.type === "join") {
    const left = evaluateBinding(binding.left, context);
    const right = evaluateBinding(binding.right, context);
    return typeof left === "string" && typeof right === "string"
      ? normalizePath(path.join(left, right))
      : MISSING;
  }
  if (binding.type === "template") {
    const source = evaluateBinding(binding.source, context);
    return typeof source === "string" ? `${binding.prefix}${source}${binding.suffix}` : MISSING;
  }
  if (binding.type === "transform") {
    const source = evaluateBinding(binding.source, context);
    return typeof source === "string" ? transform(binding.operation, source) : MISSING;
  }
  const index = context.length + binding.relativeEvent;
  const event = context[index];
  return event ? getPath(event[binding.field], binding.path) : MISSING;
}

function bindingSources(binding: ValueBinding): BindingSource[] {
  if (binding.type === "event") {
    return [{ relativeEvent: binding.relativeEvent, field: binding.field, path: binding.path }];
  }
  if (binding.type === "constant") return [];
  if (binding.type === "join") {
    return [...bindingSources(binding.left), ...bindingSources(binding.right)];
  }
  return bindingSources(binding.source);
}

function bindingComplexity(binding: ValueBinding): number {
  if (binding.type === "event") return binding.field === "output" ? 0 : 1;
  if (binding.type === "constant") return 4;
  if (binding.type === "join") return 2 + bindingComplexity(binding.left) + bindingComplexity(binding.right);
  return 1 + bindingComplexity(binding.source);
}

function getPath(value: unknown, segments: ValuePath): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return MISSING;
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) return MISSING;
      current = current[segment];
    } else {
      if (!(segment in current)) return MISSING;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function withPath(
  target: Readonly<Record<string, unknown>>,
  segments: ValuePath,
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!segments.length || segments.some((segment) => UNSAFE_SEGMENTS.has(String(segment)))) return undefined;
  const update = (current: unknown, index: number): Record<string, unknown> | unknown[] => {
    const segment = segments[index];
    if (segment === undefined) return {};
    const container: Record<string, unknown> | unknown[] =
      typeof segment === "number"
        ? Array.isArray(current)
          ? [...current]
          : []
        : asRecord(current)
          ? { ...asRecord(current) }
          : {};
    const child =
      index === segments.length - 1
        ? structuredClone(value)
        : update((current as Record<string | number, unknown> | undefined)?.[segment], index + 1);
    if (typeof segment === "number") (container as unknown[])[segment] = child;
    else (container as Record<string, unknown>)[segment] = child;
    return container;
  };
  return update(target, 0) as Readonly<Record<string, unknown>>;
}

function leaves(value: unknown, prefix: Array<string | number> = []): Array<[ValuePath, unknown]> {
  if (Array.isArray(value)) {
    return value.length
      ? value.flatMap((item, index) => leaves(item, [...prefix, index]))
      : [[prefix, []]];
  }
  const record = asRecord(value);
  if (record) {
    const entries = Object.entries(record);
    return entries.length
      ? entries.flatMap(([key, item]) => leaves(item, [...prefix, key]))
      : [[prefix, {}]];
  }
  return [[prefix, value]];
}

function transform(operation: "dirname" | "basename" | "normalize_path", value: string): string {
  if (operation === "dirname") return normalizePath(path.dirname(value));
  if (operation === "basename") return path.basename(value);
  return normalizePath(value);
}

function normalizePath(value: string): string {
  return path.normalize(value).replaceAll("\\", "/");
}

function isPathField(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("_", "");
  return (
    ["cwd", "directory", "file", "filename", "filepath", "path", "paths", "root", "uri"].includes(
      normalized,
    ) || normalized.endsWith("path") || normalized.endsWith("paths")
  );
}

function isPathSource(field: "input" | "output", sourcePath: ValuePath, value: string): boolean {
  if (!value.length || /[\r\n"'|&<>]/.test(value)) return false;
  const key = String(sourcePath.at(-1) ?? "").toLowerCase();
  if (
    field === "output" &&
    ["content", "diff", "message", "output", "preview", "stderr", "stdout", "text"].includes(key)
  ) {
    return false;
  }
  return (
    key.includes("path") ||
    key.includes("file") ||
    key.includes("dir") ||
    ["cwd", "name", "root", "uri"].includes(key) ||
    /[\\/]/.test(value)
  );
}

function requiresProvenance(targetPath: ValuePath, value: unknown): boolean {
  const key = String(targetPath.at(-1) ?? "").toLowerCase().replaceAll("_", "");
  if (isPathField(key)) return true;
  if (typeof value !== "string") return false;
  return [
    "command",
    "content",
    "patch",
    "pattern",
    "query",
    "replacement",
    "script",
    "text",
    "url",
  ].some((name) => key === name || key.endsWith(name));
}

function isSecretPath(value: ValuePath): boolean {
  return value.some((segment) => {
    const normalized = String(segment).toLowerCase().replaceAll(/[-_]/g, "");
    return SECRET_SEGMENTS.some((secret) => normalized === secret || normalized.endsWith(secret));
  });
}

function uniqueBindings(bindings: readonly ValueBinding[]): ValueBinding[] {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = stableStringify(binding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueSources(sources: readonly BindingSource[]): BindingSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = stableStringify(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniquePathSources(
  values: readonly { readonly binding: ValueBinding; readonly value: string }[],
): Array<{ readonly binding: ValueBinding; readonly value: string }> {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = stableStringify(item.binding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniquePaths(paths: readonly ValuePath[]): ValuePath[] {
  const seen = new Set<string>();
  return paths.filter((value) => {
    const key = encodePath(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  return stableStringify(left) === stableStringify(right);
}

function isValuePath(value: unknown): value is ValuePath {
  return (
    Array.isArray(value) &&
    value.every(
      (segment) => typeof segment === "string" || (Number.isSafeInteger(segment) && segment >= 0),
    )
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

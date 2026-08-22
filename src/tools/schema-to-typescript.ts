import type { RegisteredTool } from "./types.js";

export function renderToolSdk(tools: readonly RegisteredTool[]): string {
  const namespaces = new Map<string, RegisteredTool[]>();
  for (const tool of tools) {
    const group = namespaces.get(tool.codeNamespace) ?? [];
    group.push(tool);
    namespaces.set(tool.codeNamespace, group);
  }
  const lines = [
    "interface CodeModeTextResultEnvelope {",
    "  readonly content: readonly unknown[];",
    "  readonly isError: boolean;",
    "}",
    "",
    "declare const tools: {",
  ];
  for (const [namespace, group] of [...namespaces].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`  readonly ${JSON.stringify(namespace)}: {`);
    for (const tool of group.sort((left, right) => left.codeName.localeCompare(right.codeName))) {
      if (tool.definition.description) {
        lines.push(`    /** ${commentText(tool.definition.description)} */`);
      }
      const input = schemaToTypeScript(tool.definition.inputSchema);
      const output = tool.definition.outputSchema
        ? schemaToTypeScript(tool.definition.outputSchema)
        : "CodeModeTextResultEnvelope";
      lines.push(
        `    readonly ${JSON.stringify(tool.codeName)}: (args: ${input}) => Promise<${output}>;`,
      );
    }
    lines.push("  };");
  }
  lines.push("};");
  return lines.join("\n");
}

export function renderToolDeclaration(tool: RegisteredTool): string {
  const description = tool.definition.description
    ? `/** ${commentText(tool.definition.description)} */\n`
    : "";
  const input = schemaToTypeScript(tool.definition.inputSchema);
  const output = tool.definition.outputSchema
    ? schemaToTypeScript(tool.definition.outputSchema)
    : "{ readonly content: readonly unknown[]; readonly isError: boolean }";
  return `${description}${toolCodeReference(tool)}: (args: ${input}) => Promise<${output}>`;
}

export function toolCodeReference(tool: RegisteredTool): string {
  return `tools[${JSON.stringify(tool.codeNamespace)}][${JSON.stringify(tool.codeName)}]`;
}

export function schemaToTypeScript(schema: unknown): string {
  return renderSchema(schema, schema, new Set(), 0);
}

function renderSchema(
  schema: unknown,
  root: unknown,
  refs: ReadonlySet<string>,
  depth: number,
): string {
  if (depth > 16) return "unknown";
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  const record = asRecord(schema);
  if (!record) return "unknown";

  if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
    if (refs.has(record.$ref)) return "unknown";
    const resolved = resolveRef(root, record.$ref);
    if (resolved === undefined) return "unknown";
    return renderSchema(resolved, root, new Set([...refs, record.$ref]), depth + 1);
  }
  if ("const" in record) return literal(record.const);
  if (Array.isArray(record.enum) && record.enum.length) {
    return record.enum.map(literal).join(" | ");
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(record[key]) && record[key].length) {
      return record[key]
        .map((item) => parenthesize(renderSchema(item, root, refs, depth + 1)))
        .join(" | ");
    }
  }
  if (Array.isArray(record.allOf) && record.allOf.length) {
    return record.allOf
      .map((item) => parenthesize(renderSchema(item, root, refs, depth + 1)))
      .join(" & ");
  }

  const types = Array.isArray(record.type)
    ? record.type.filter((item): item is string => typeof item === "string")
    : typeof record.type === "string"
      ? [record.type]
      : [];
  if (types.length > 1) {
    return types
      .map((type) => renderSchema({ ...record, type }, root, refs, depth + 1))
      .join(" | ");
  }
  const type = types[0];
  if (type === "null") return "null";
  if (type === "boolean") return "boolean";
  if (type === "integer" || type === "number") return "number";
  if (type === "string") return "string";
  if (type === "array" || record.items !== undefined) {
    if (Array.isArray(record.prefixItems)) {
      return `[${record.prefixItems
        .map((item) => renderSchema(item, root, refs, depth + 1))
        .join(", ")}]`;
    }
    return `Array<${renderSchema(record.items, root, refs, depth + 1)}>`;
  }
  if (type === "object" || record.properties !== undefined || record.additionalProperties !== undefined) {
    return renderObject(record, root, refs, depth + 1);
  }
  return "unknown";
}

function renderObject(
  record: Record<string, unknown>,
  root: unknown,
  refs: ReadonlySet<string>,
  depth: number,
): string {
  const properties = asRecord(record.properties) ?? {};
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const fields = Object.entries(properties).map(([key, value]) => {
    const optional = required.has(key) ? "" : "?";
    return `readonly ${JSON.stringify(key)}${optional}: ${renderSchema(value, root, refs, depth + 1)};`;
  });
  if (record.additionalProperties === true) fields.push("readonly [key: string]: unknown;");
  else if (record.additionalProperties && typeof record.additionalProperties === "object") {
    fields.push(
      `readonly [key: string]: ${renderSchema(record.additionalProperties, root, refs, depth + 1)};`,
    );
  }
  return fields.length ? `{ ${fields.join(" ")} }` : "Record<string, unknown>";
}

function resolveRef(root: unknown, ref: string): unknown {
  let current = root;
  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    const record = asRecord(current);
    if (!record || !(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
}

function literal(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "unknown" : serialized;
  }
  return "unknown";
}

function parenthesize(value: string): string {
  return value.includes(" | ") || value.includes(" & ") ? `(${value})` : value;
}

function commentText(value: string): string {
  return value.replaceAll("*/", "*\\/").replaceAll(/\s+/g, " ").trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

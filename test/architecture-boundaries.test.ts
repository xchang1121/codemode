import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("Code Mode architecture boundaries", () => {
  test("keeps the execution substrate independent of tools, MCP and learning", async () => {
    const imports = await moduleSpecifiers("../src/execution/quickjs-runtime.ts");

    expect(imports).toEqual(expect.arrayContaining([
      "quickjs-emscripten",
      "./code-runtime.js",
    ]));
    expect(imports.some((specifier) =>
      /(?:^|\/)(?:tools|gateway|learning|hints|code-mode)(?:\/|$)/.test(specifier),
    )).toBe(false);
  });

  test("keeps the MCP gateway dependent only on the application boundary and wire contract", async () => {
    const imports = await moduleSpecifiers("../src/gateway/code-mode-gateway.ts");
    const local = imports.filter((specifier) => specifier.startsWith(".."));

    expect([...new Set(local)].sort()).toEqual([
      "../code-mode/composition.js",
      "../code-mode/contract.js",
      "../code-mode/service.js",
    ]);
    expect(imports.some((specifier) =>
      /(?:^|\/)(?:execution|learning|hints|tools)(?:\/|$)/.test(specifier),
    )).toBe(false);
  });

  test("keeps orchestration on ports instead of concrete runtime or learning classes", async () => {
    const imports = await moduleSpecifiers("../src/code-mode/service.ts");

    expect(imports).toContain("./ports.js");
    expect(imports).toContain("../execution/types.js");
    expect(imports.some((specifier) =>
      specifier.includes("quickjs") ||
      specifier.includes("fusion-learner") ||
      specifier.includes("fusion-advisor") ||
      specifier.includes("gateway"),
    )).toBe(false);
  });

  test("confines concrete assembly to the composition module", async () => {
    const contract = await source("../src/code-mode/contract.ts");
    const ports = await source("../src/code-mode/ports.ts");
    const service = await source("../src/code-mode/service.ts");
    const composition = await source("../src/code-mode/composition.ts");

    for (const isolated of [contract, ports, service]) {
      expect(isolated).not.toContain("new FusionLearner");
      expect(isolated).not.toContain("new FusionAdvisor");
      expect(isolated).not.toContain("new QuickJsCodeRuntime");
    }
    expect(composition).toContain("new FusionAdvisor");
    expect(composition).toContain("new CodeModeService");
  });
});

async function moduleSpecifiers(relativePath: string): Promise<string[]> {
  const text = await source(relativePath);
  return [...text.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

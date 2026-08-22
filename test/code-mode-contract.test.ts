import { describe, expect, test } from "vitest";
import {
  CODE_MODE_INSTRUCTIONS,
  CODE_MODE_META_KEY,
  CODE_MODE_SESSION_META_KEY,
  CODE_MODE_TOOL_NAMES,
  codeModeSessionId,
  codeModeToolDefinitions,
  parseCodeModeRequest,
} from "../src/code-mode/contract.js";

describe("Code Mode contract", () => {
  test("keeps names, schemas and instructions in one model-visible contract", () => {
    const definitions = codeModeToolDefinitions();

    expect(definitions.map((definition) => definition.name)).toEqual([
      CODE_MODE_TOOL_NAMES.search,
      CODE_MODE_TOOL_NAMES.describe,
      CODE_MODE_TOOL_NAMES.suggest,
      CODE_MODE_TOOL_NAMES.execute,
    ]);
    expect(CODE_MODE_INSTRUCTIONS).toContain("await tools[namespace][name](args)");
    expect(CODE_MODE_INSTRUCTIONS).toContain("only values printed or returned");
    expect(
      definitions.find((definition) => definition.name === CODE_MODE_TOOL_NAMES.execute)?.description,
    ).toContain("intermediate values stay inside the run");
  });

  test("returns detached tool definitions", () => {
    const first = codeModeToolDefinitions();
    first[0]!.description = "mutated";

    expect(codeModeToolDefinitions()[0]?.description).not.toBe("mutated");
  });

  test("parses the published execute shape into the internal naming convention", () => {
    expect(
      parseCodeModeRequest(CODE_MODE_TOOL_NAMES.execute, {
        description: "Load one record",
        allowed_tools: ["docs::search", "docs::get"],
        code: "return 1;",
      }),
    ).toEqual({
      kind: "execute",
      name: CODE_MODE_TOOL_NAMES.execute,
      input: {
        description: "Load one record",
        allowedTools: ["docs::search", "docs::get"],
        code: "return 1;",
      },
    });
  });

  test("applies the same defaults and limits as the published schemas", () => {
    expect(parseCodeModeRequest(CODE_MODE_TOOL_NAMES.search, { query: "docs" })).toEqual({
      kind: "search",
      name: CODE_MODE_TOOL_NAMES.search,
      input: { query: "docs", limit: 12 },
    });
    expect(() =>
      parseCodeModeRequest(CODE_MODE_TOOL_NAMES.execute, {
        description: "duplicate",
        allowed_tools: ["docs::get", "docs::get"],
        code: "return 1;",
      }),
    ).toThrow("must not contain duplicates");
    expect(() =>
      parseCodeModeRequest(CODE_MODE_TOOL_NAMES.execute, {
        description: "   ",
        allowed_tools: ["docs::get"],
        code: "return 1;",
      }),
    ).toThrow("description must be a non-empty string");
  });

  test("leaves unknown names for the direct-tool adapter and resolves session metadata", () => {
    expect(parseCodeModeRequest("docs__get", {})).toBeUndefined();
    expect(CODE_MODE_META_KEY).not.toBe(CODE_MODE_SESSION_META_KEY);
    expect(codeModeSessionId("transport", { [CODE_MODE_SESSION_META_KEY]: "task" })).toBe("task");
    expect(codeModeSessionId("transport", undefined)).toBe("transport");
    expect(codeModeSessionId(undefined, undefined)).toBe("default");
  });
});

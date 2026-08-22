import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { resolveCodeModeConfig } from "../src/config.js";

const SCHEMA_PATH = fileURLToPath(new URL("../codemode.config.schema.json", import.meta.url));
const EXAMPLE_PATH = fileURLToPath(new URL("../examples/codemode.config.json", import.meta.url));

describe("published configuration artifacts", () => {
  test("the example satisfies both JSON Schema and runtime validation", async () => {
    const schema: unknown = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
    const example: unknown = JSON.parse(await readFile(EXAMPLE_PATH, "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema as object);

    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(() =>
      resolveCodeModeConfig(example, {
        configPath: EXAMPLE_PATH,
        environment: {
          WORKSPACE_MCP_TOKEN: "workspace-test-token",
          REMOTE_MCP_URL: "https://example.test/mcp",
          REMOTE_MCP_TOKEN: "remote-test-token",
        },
      }),
    ).not.toThrow();
  });
});

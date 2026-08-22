import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CodeModeConfigError,
  expandEnvironment,
  resolveCodeModeConfig,
} from "../src/config.js";

describe("Code Mode config", () => {
  test("resolves relative paths and environment placeholders", () => {
    const configPath = resolve("fixture", "codemode.config.json");
    const config = resolveCodeModeConfig(
      {
        version: 1,
        servers: {
          local: {
            transport: "stdio",
            command: "${NODE_BIN}",
            args: ["server.js", "${WORKSPACE}"],
            cwd: "./upstream",
            env: { ACCESS_TOKEN: "${TOKEN}" },
          },
          remote: {
            transport: "http",
            url: "https://example.test/${MCP_PATH}",
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
        },
        state: { path: "./state/fusion.json", debounceMs: 25 },
      },
      {
        configPath,
        environment: {
          NODE_BIN: "node",
          WORKSPACE: "C:/workspace",
          TOKEN: "secret-value",
          MCP_PATH: "mcp",
        },
      },
    );

    expect(config.servers).toEqual([
      {
        namespace: "local",
        provider: {
          transport: "stdio",
          command: "node",
          args: ["server.js", "C:/workspace"],
          cwd: resolve(dirname(configPath), "upstream"),
          env: { ACCESS_TOKEN: "secret-value" },
        },
      },
      {
        namespace: "remote",
        provider: {
          transport: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer secret-value" },
        },
      },
    ]);
    expect(config.state).toEqual({
      path: resolve(dirname(configPath), "state", "fusion.json"),
      debounceMs: 25,
      maxStateBytes: 16 * 1024 * 1024,
    });
  });

  test("applies safe operational defaults and allows persistence to be disabled", () => {
    const config = resolveCodeModeConfig({
      servers: { demo: { transport: "stdio", command: "demo-server" } },
      state: false,
    });

    expect(config.gateway).toEqual({
      exposeDirectTools: true,
      hintDelivery: "both",
      maxActiveHints: 2,
      name: "codemode-gateway",
    });
    expect(config.state).toBeUndefined();
  });

  test("fails clearly on missing environment variables and unknown fields", () => {
    expect(() => expandEnvironment("Bearer ${MISSING}", {})).toThrow(
      /Environment variable MISSING/,
    );
    expect(() =>
      resolveCodeModeConfig({
        servers: { demo: { transport: "stdio", command: "node", surprise: true } },
      }),
    ).toThrow(CodeModeConfigError);
  });
});

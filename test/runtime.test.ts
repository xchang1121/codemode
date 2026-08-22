import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveCodeModeConfig } from "../src/config.js";
import { createCodeModeRuntime, type CodeModeRuntime } from "../src/runtime.js";

const UPSTREAM_FIXTURE = fileURLToPath(
  new URL("./fixtures/stdio-upstream.mjs", import.meta.url),
);

describe("createCodeModeRuntime", () => {
  let directory: string;
  let runtime: CodeModeRuntime | undefined;
  let client: Client | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codemode-runtime-test-"));
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  test("aggregates a stdio MCP server and restores learned hints after restart", async () => {
    const statePath = resolve(directory, "fusion.json");
    const config = resolveCodeModeConfig(
      {
        servers: {
          fixture: {
            transport: "stdio",
            command: process.execPath,
            args: [UPSTREAM_FIXTURE],
          },
        },
        state: { path: statePath, debounceMs: 60_000 },
      },
      { configPath: resolve(directory, "codemode.config.json") },
    );

    await connect(config);
    await train("alpha");
    await train("beta");
    await disconnect();
    expect(await readFile(statePath, "utf8")).toContain("codemode-fusion-state");

    await connect(config);
    expect(runtime?.stateLoadResult).toEqual(expect.objectContaining({ status: "loaded" }));
    const searched = await call("fixture__search", { query: "gamma" });
    expect(
      searched.content.some(
        (item) => item.type === "text" && item.text.includes("[Code Mode fusion hint]"),
      ),
    ).toBe(true);
  });

  async function connect(config: ReturnType<typeof resolveCodeModeConfig>): Promise<void> {
    runtime = await createCodeModeRuntime(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.connect(serverTransport);
    client = new Client({ name: "runtime-test", version: "1.0.0" });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("fixture__search");
  }

  async function disconnect(): Promise<void> {
    await client?.close();
    client = undefined;
    await runtime?.close();
    runtime = undefined;
  }

  async function train(query: string): Promise<void> {
    const searched = await call("fixture__search", { query });
    const items = asRecord(searched.structuredContent)?.items;
    const first = Array.isArray(items) ? asRecord(items[0]) : undefined;
    await call("fixture__get", { id: first?.id });
  }

  async function call(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<CallToolResult> {
    if (!client) throw new Error("Test client is not connected");
    const result = await client.callTool({ name, arguments: args });
    if (!isCallToolResult(result)) throw new Error("Unexpected MCP task result");
    return result;
  }
});

function isCallToolResult(value: unknown): value is CallToolResult {
  return Array.isArray(asRecord(value)?.content);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

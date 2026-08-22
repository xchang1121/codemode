import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { QuickJsCodeExecutor } from "../src/execution/quickjs-executor.js";
import { CodeModeGateway } from "../src/gateway/code-mode-gateway.js";
import { InMemoryToolProvider } from "../src/tools/in-memory-provider.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

const SESSION_META = {
  "io.github.xchang1121/codemode-session": "gateway-integration",
};

describe("CodeModeGateway", () => {
  let client: Client;
  let gateway: CodeModeGateway;

  beforeEach(async () => {
    const registry = new ToolRegistry();
    await registry.addProvider(
      new InMemoryToolProvider("docs", [
        {
          definition: {
            name: "search",
            description: "Search documents and return stable document identifiers",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
            outputSchema: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["items"],
              additionalProperties: false,
            },
          },
          handler: (args) => {
            const query = String(args.query);
            return {
              content: [{ type: "text", text: `Found ${query}` }],
              structuredContent: { items: [{ id: `doc-${query}` }] },
            };
          },
        },
        {
          definition: {
            name: "get",
            description: "Get one document by its stable identifier",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
            outputSchema: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
              },
              required: ["id", "title"],
              additionalProperties: false,
            },
          },
          handler: (args) => ({
            content: [{ type: "text", text: `Loaded ${String(args.id)}` }],
            structuredContent: {
              id: args.id,
              title: `Title for ${String(args.id)}`,
            },
          }),
        },
      ]),
    );
    gateway = new CodeModeGateway({
      registry,
      executor: new QuickJsCodeExecutor(registry),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.connect(serverTransport);
    client = new Client({ name: "gateway-test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await Promise.allSettled([client.close(), gateway.close()]);
  });

  test("exposes discovery, execution and namespaced direct tools", async () => {
    expect(client.getInstructions()).toContain(
      "copy a hint's allowedTools stable IDs exactly into codemode_execute.allowed_tools",
    );
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "codemode_search",
      "codemode_describe",
      "codemode_suggest",
      "codemode_execute",
      "docs__get",
      "docs__search",
    ]);
    expect(listed.tools.find((tool) => tool.name === "codemode_execute")?.description).toContain(
      "allowed_tools",
    );

    const searched = await call("codemode_search", { query: "documents" });
    expect(recordArray(searched.structuredContent, "tools")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "docs::search", codeReference: 'tools["docs"]["search"]' }),
      ]),
    );

    const described = await call("codemode_describe", {
      names: ["docs::search", "docs__get"],
    });
    expect(asRecord(described.structuredContent)?.sdk).toContain('readonly "docs"');
    expect(asRecord(described.structuredContent)?.sdk).toContain("search");
  });

  test("learns structured search-to-get data flow and proactively surfaces it", async () => {
    await trainSearchGet("alpha");
    await trainSearchGet("beta");

    const thirdSearch = await call("docs__search", { query: "gamma" });
    expect(thirdSearch.structuredContent).toEqual({ items: [{ id: "doc-gamma" }] });
    expect(
      thirdSearch.content.some(
        (item) =>
          item.type === "text" &&
          item.text.includes("[Code Mode fusion hint]") &&
          item.text.includes('allowed_tools: ["docs::search","docs::get"]'),
      ),
    ).toBe(true);
    expect(asRecord(thirdSearch._meta)?.["io.github.xchang1121/codemode"]).toEqual(
      expect.objectContaining({ fusionHints: expect.any(Array) }),
    );

    const suggested = await call("codemode_suggest", { task: "load search result" });
    const hints = recordArray(suggested.structuredContent, "hints");
    expect(hints[0]).toEqual(
      expect.objectContaining({
        allowedTools: ["docs::search", "docs::get"],
        tools: ["docs.search", "docs.get"],
        dataflowEdges: 1,
        code: expect.stringContaining('tools["docs"]["get"]'),
      }),
    );
    expect(asRecord(hints[0])?.code).toContain('step1["items"][0]["id"]');
  });

  test("runs a dependent multi-tool program in one outer MCP call", async () => {
    const executed = await call("codemode_execute", {
      description: "Find and load one document",
      allowed_tools: ["docs::search", "docs::get"],
      code: `
        const found = await tools.docs.search({ query: "delta" });
        return tools.docs.get({ id: found.items[0].id });
      `,
    });

    expect(executed.isError).not.toBe(true);
    expect(asRecord(executed.structuredContent)?.value).toEqual({
      id: "doc-delta",
      title: "Title for doc-delta",
    });
    expect(asRecord(executed.structuredContent)?.toolCalls).toBe(2);
  });

  test("keeps unlisted tools outside the sandbox", async () => {
    const executed = await call("codemode_execute", {
      description: "Attempt an unlisted call",
      allowed_tools: ["docs::search"],
      code: "return tools.docs.get({ id: 'doc-hidden' });",
    });

    expect(executed.isError).toBe(true);
    expect(executed.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("not a function") }),
    );
  });

  test("rejects Code Mode arguments that do not match the published schema", async () => {
    const invalidSearch = await call("codemode_search", { unexpected: true });
    expect(invalidSearch.isError).toBe(true);
    expect(invalidSearch.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("Unexpected argument") }),
    );

    const duplicateAllowlist = await call("codemode_execute", {
      description: "duplicate",
      allowed_tools: ["docs::search", "docs::search"],
      code: "return 1;",
    });
    expect(duplicateAllowlist.isError).toBe(true);
    expect(duplicateAllowlist.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("must not contain duplicates") }),
    );
  });

  async function trainSearchGet(query: string): Promise<void> {
    const searched = await call("docs__search", { query });
    const items = recordArray(searched.structuredContent, "items");
    const id = asRecord(items[0])?.id;
    expect(typeof id).toBe("string");
    await call("docs__get", { id });
  }

  async function call(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<CallToolResult> {
    const result = await client.callTool({ name, arguments: args, _meta: SESSION_META });
    if (!isCallToolResult(result)) throw new Error(`Unexpected task result from ${name}`);
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

function recordArray(value: unknown, key: string): unknown[] {
  const item = asRecord(value)?.[key];
  return Array.isArray(item) ? item : [];
}

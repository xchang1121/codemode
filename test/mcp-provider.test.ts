import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";
import { McpToolProvider } from "../src/tools/mcp-provider.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

const close: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(close.splice(0).map((item) => item()));
});

describe("McpToolProvider", () => {
  test("aggregates an upstream MCP server through the common registry", async () => {
    const upstream = new Server(
      { name: "upstream-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    upstream.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "echo",
          description: "Echo structured input",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          outputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      ],
    }));
    upstream.setRequestHandler(CallToolRequestSchema, (request) => ({
      content: [{ type: "text", text: String(request.params.arguments?.value) }],
      structuredContent: { value: request.params.arguments?.value },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverTransport);
    close.push(() => upstream.close());

    const registry = new ToolRegistry();
    await registry.addProvider(McpToolProvider.fromTransport("up", clientTransport));
    close.push(() => registry.close());

    expect(registry.list()).toEqual([
      expect.objectContaining({ id: "up::echo", gatewayName: "up__echo" }),
    ]);
    await expect(
      registry.call("up::echo", { value: "hello" }, { sessionId: "one", source: "code" }),
    ).resolves.toMatchObject({ structuredContent: { value: "hello" } });
  });

  test("can be consumed by the official MCP client after transport injection", async () => {
    const upstream = new Server(
      { name: "upstream-list", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    upstream.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverTransport);
    close.push(() => upstream.close());

    const client = new Client({ name: "sanity-client", version: "1.0.0" });
    await client.connect(clientTransport);
    close.push(() => client.close());
    await expect(client.listTools()).resolves.toEqual(expect.objectContaining({ tools: [] }));
  });

  test("collects every upstream tools/list page", async () => {
    const upstream = new Server(
      { name: "upstream-pages", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    upstream.setRequestHandler(ListToolsRequestSchema, (request) =>
      request.params?.cursor === "second"
        ? { tools: [{ name: "two", inputSchema: { type: "object" } }] }
        : {
            tools: [{ name: "one", inputSchema: { type: "object" } }],
            nextCursor: "second",
          },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverTransport);
    close.push(() => upstream.close());

    const registry = new ToolRegistry();
    await registry.addProvider(McpToolProvider.fromTransport("paged", clientTransport));
    close.push(() => registry.close());

    expect(registry.list().map((tool) => tool.id)).toEqual(["paged::one", "paged::two"]);
  });
});

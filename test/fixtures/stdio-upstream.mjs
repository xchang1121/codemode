import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "codemode-test-upstream", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "search",
      description: "Search fixture records",
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
    {
      name: "get",
      description: "Load one fixture record",
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
          value: { type: "string" },
        },
        required: ["id", "value"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === "search") {
    const query = String(args.query);
    return {
      content: [{ type: "text", text: `Found ${query}` }],
      structuredContent: { items: [{ id: `fixture-${query}` }] },
    };
  }
  if (request.params.name === "get") {
    const id = String(args.id);
    return {
      content: [{ type: "text", text: `Loaded ${id}` }],
      structuredContent: { id, value: `Value for ${id}` },
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `Unknown fixture tool: ${request.params.name}` }],
  };
});

await server.connect(new StdioServerTransport());

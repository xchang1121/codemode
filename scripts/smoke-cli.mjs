import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "codemode-cli-smoke-"));
const configPath = join(directory, "codemode.config.json");
await writeFile(
  configPath,
  JSON.stringify(
    {
      version: 1,
      servers: {
        fixture: {
          transport: "stdio",
          command: process.execPath,
          args: [join(root, "test", "fixtures", "stdio-upstream.mjs")],
        },
      },
      state: false,
    },
    null,
    2,
  ),
  "utf8",
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "cli.js"), "--config", configPath],
  cwd: root,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += String(chunk);
});
const client = new Client({ name: "codemode-cli-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert(listed.tools.some((tool) => tool.name === "codemode_execute"));
  assert(listed.tools.some((tool) => tool.name === "fixture__search"));

  const result = await client.callTool({
    name: "codemode_execute",
    arguments: {
      description: "CLI smoke test",
      allowed_tools: ["fixture::search", "fixture::get"],
      code: `
        const found = await tools.fixture.search({ query: "smoke" });
        return tools.fixture.get({ id: found.items[0].id });
      `,
    },
  });
  assert("content" in result, "Expected an immediate tool result");
  assert.equal(result.isError, undefined, stderr);
  assert.deepEqual(result.structuredContent?.value, {
    id: "fixture-smoke",
    value: "Value for fixture-smoke",
  });
  process.stdout.write("Code Mode CLI smoke test passed.\n");
} finally {
  await client.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

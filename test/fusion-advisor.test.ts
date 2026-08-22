import { beforeEach, describe, expect, test } from "vitest";
import { FusionAdvisor } from "../src/hints/fusion-advisor.js";
import { InMemoryToolProvider } from "../src/tools/in-memory-provider.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

describe("FusionAdvisor", () => {
  let registry: ToolRegistry;

  beforeEach(async () => {
    registry = new ToolRegistry();
    await registry.addProvider(new InMemoryToolProvider("docs", [
      {
        definition: {
          name: "search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
        handler: (args) => ({ content: [], structuredContent: { id: `doc-${String(args.query)}` } }),
      },
      {
        definition: {
          name: "get",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
        handler: (args) => ({ content: [], structuredContent: { title: `Title ${String(args.id)}` } }),
      },
    ]));
  });

  test("owns observation, rendering, delivery and semantic change notification", async () => {
    let persistenceCalls = 0;
    let hintChanges = 0;
    const advisor = new FusionAdvisor({
      registry,
      onLearnerChanged: () => {
        persistenceCalls++;
        throw new Error("observer failure must be contained");
      },
    });
    advisor.onHintsChanged(() => {
      hintChanges++;
    });

    await train("learning", "alpha");
    await train("learning", "beta");

    const common = advisor.commonHints("load document", 5);
    expect(common[0]).toEqual(expect.objectContaining({
      allowedTools: ["docs::search", "docs::get"],
      tools: ["docs.search", "docs.get"],
      dataflowEdges: 1,
    }));
    expect(persistenceCalls).toBe(4);
    expect(hintChanges).toBeGreaterThan(0);

    const searched = await registry.call("docs::search", { query: "gamma" }, {
      sessionId: "learning",
      source: "direct",
    });
    const decorated = advisor.attachHints(searched, "learning");
    expect(decorated.structuredContent).toEqual({ id: "doc-gamma" });
    expect(decorated.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("[Code Mode fusion hint]"),
      }),
    ]));

    advisor.close();
    await registry.close();
  });

  test("keeps same-batch siblings out of each other's causal context", async () => {
    const advisor = new FusionAdvisor({ registry });
    for (const [batch, query] of [["one", "alpha"], ["two", "beta"]] as const) {
      await registry.call("docs::search", { query }, {
        sessionId: "parallel",
        source: "code",
        batchId: batch,
        batchIndex: 0,
        batchSize: 2,
      });
      await registry.call("docs::get", { id: `doc-${query}` }, {
        sessionId: "parallel",
        source: "code",
        batchId: batch,
        batchIndex: 1,
        batchSize: 2,
      });
    }

    expect(advisor.commonHints("", 5)).toEqual([]);
    advisor.close();
    await registry.close();
  });

  async function train(sessionId: string, query: string): Promise<void> {
    const found = await registry.call("docs::search", { query }, { sessionId, source: "direct" });
    const id = asRecord(found.structuredContent).id;
    await registry.call("docs::get", { id }, { sessionId, source: "direct" });
  }
});

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected object");
  }
  return value as Record<string, unknown>;
}

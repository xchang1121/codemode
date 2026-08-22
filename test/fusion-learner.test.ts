import { describe, expect, test } from "vitest";
import { FusionLearner } from "../src/learning/fusion-learner.js";

describe("FusionLearner", () => {
  test("learns search -> get control flow and its structured data-flow edge", () => {
    const learner = new FusionLearner();
    trainSearchGet(learner, "one", "A");
    trainSearchGet(learner, "two", "B");

    learner.observe({
      sessionId: "probe",
      tool: "search",
      input: { query: "open" },
      output: { items: [{ id: "C" }] },
      outcome: "success",
    });
    const candidate = learner.predict("probe").find((item) => item.tool === "get");

    expect(candidate).toMatchObject({
      tool: "get",
      input: { id: "C" },
      missing: [],
      occurrences: 2,
    });
    expect(candidate?.dependencies).toContainEqual({
      targetPath: ["id"],
      sources: [{ relativeEvent: -1, field: "output", path: ["items", 0, "id"] }],
    });
    expect(candidate?.ppmOrder).toBeGreaterThanOrEqual(1);
  });

  test("ranks the more frequent successor first with a one-candidate budget", () => {
    const learner = new FusionLearner({ maxSuggestions: 1 });
    for (let index = 0; index < 4; index++) trainConstantPath(learner, `get-${index}`, "get", { id: "A" });
    for (let index = 0; index < 2; index++) {
      trainConstantPath(learner, `shell-${index}`, "shell", { command: "npm test" });
    }
    learner.observe({ sessionId: "probe", tool: "search", input: {}, outcome: "success" });

    expect(learner.predict("probe")).toEqual([expect.objectContaining({ tool: "get" })]);
  });

  test("does not invent causal edges between parallel sibling calls", () => {
    const learner = new FusionLearner();
    for (const sessionId of ["one", "two"]) {
      learner.observeBatch([
        { sessionId, turnId: `${sessionId}:scan`, tool: "search", input: {}, outcome: "success" },
        { sessionId, turnId: `${sessionId}:scan`, tool: "list", input: {}, outcome: "success" },
      ]);
      learner.observe({ sessionId, tool: "get", input: { id: "A" }, outcome: "success" });
      learner.finishSession(sessionId);
    }

    expect(
      learner
        .learnedPatterns()
        .some(
          (pattern) =>
            (pattern.targetTool === "search" || pattern.targetTool === "list") &&
            pattern.contextTools.some((tool) => tool === "search" || tool === "list"),
        ),
    ).toBe(false);
  });

  test("unfolds a learned three-tool fusion path", () => {
    const learner = new FusionLearner({ maxPathDepth: 3 });
    for (const [sessionId, id, title] of [
      ["one", "A", "Alpha"],
      ["two", "B", "Beta"],
    ] as const) {
      learner.observe({
        sessionId,
        tool: "search",
        input: { query: "open" },
        output: { items: [{ id }] },
        outcome: "success",
      });
      learner.observe({
        sessionId,
        tool: "get",
        input: { id },
        output: { title },
        outcome: "success",
      });
      learner.observe({
        sessionId,
        tool: "send",
        input: { text: title },
        outcome: "success",
      });
      learner.finishSession(sessionId);
    }

    expect(learner.commonPaths()).toContainEqual(
      expect.objectContaining({
        tools: ["search", "get", "send"],
        dataflowEdges: 2,
      }),
    );
  });

  test("restores compact PPM and pattern state without persisting raw outputs", () => {
    const learner = new FusionLearner();
    trainSearchGet(learner, "one", "A");
    trainSearchGet(learner, "two", "B");
    const serialized = JSON.stringify(learner.snapshot());
    // Structural source paths are retained, but observed result values are not.
    expect(serialized).not.toContain('"A"');
    expect(serialized).not.toContain('"B"');

    const restored = new FusionLearner();
    expect(restored.restore(JSON.parse(serialized))).toBe(true);
    restored.observe({
      sessionId: "probe",
      tool: "search",
      input: {},
      output: { items: [{ id: "C" }] },
      outcome: "success",
    });

    expect(restored.predict("probe")).toContainEqual(
      expect.objectContaining({ tool: "get", input: { id: "C" } }),
    );
  });

  test("suppresses persisted paths when an upstream target schema changed", () => {
    const learner = new FusionLearner();
    for (const [sessionId, id] of [["one", "A"], ["two", "B"]] as const) {
      learner.observe({
        sessionId,
        tool: "search",
        schemaHash: "search-v1",
        input: {},
        output: { items: [{ id }] },
        outcome: "success",
      });
      learner.observe({
        sessionId,
        tool: "get",
        schemaHash: "get-v1",
        input: { id },
        outcome: "success",
      });
      learner.finishSession(sessionId);
    }

    expect(
      learner.commonPaths(8, { search: "search-v1", get: "get-v1" }),
    ).not.toHaveLength(0);
    expect(
      learner.commonPaths(8, { search: "search-v1", get: "get-v2" }),
    ).toHaveLength(0);
  });
});

function trainSearchGet(learner: FusionLearner, sessionId: string, id: string): void {
  learner.observe({
    sessionId,
    tool: "search",
    input: { query: "open" },
    output: { items: [{ id }] },
    outcome: "success",
  });
  learner.observe({ sessionId, tool: "get", input: { id }, outcome: "success" });
  learner.finishSession(sessionId);
}

function trainConstantPath(
  learner: FusionLearner,
  sessionId: string,
  targetTool: string,
  input: Record<string, unknown>,
): void {
  learner.observe({ sessionId, tool: "search", input: {}, outcome: "success" });
  learner.observe({ sessionId, tool: targetTool, input, outcome: "success", durationMs: 1 });
  learner.finishSession(sessionId);
}

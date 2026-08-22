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

  test("accumulates pre-pattern evidence across short-lived processes", () => {
    const firstProcess = new FusionLearner();
    trainSearchGet(firstProcess, "first-process", "private-first-id");
    expect(firstProcess.learnedPatterns()).toHaveLength(0);

    const serialized = JSON.stringify(firstProcess.snapshot());
    expect(serialized).not.toContain("private-first-id");
    expect(JSON.parse(serialized)).toEqual(
      expect.objectContaining({ version: 2, pools: expect.any(Array) }),
    );

    const secondProcess = new FusionLearner();
    expect(secondProcess.restore(JSON.parse(serialized))).toBe(true);
    trainSearchGet(secondProcess, "second-process", "private-second-id");

    expect(secondProcess.commonPaths()).toContainEqual(
      expect.objectContaining({ tools: ["search", "get"], dataflowEdges: 1 }),
    );
    expect(JSON.stringify(secondProcess.snapshot())).not.toContain("private-second-id");
  });

  test("can disable pre-pattern evidence persistence for privacy or ablation", () => {
    const firstProcess = new FusionLearner({ persistBindingEvidence: false });
    trainSearchGet(firstProcess, "first-process", "A");
    const snapshot = firstProcess.snapshot();
    expect(snapshot).toEqual(expect.objectContaining({ version: 2, pools: [] }));

    const secondProcess = new FusionLearner({ persistBindingEvidence: false });
    expect(secondProcess.restore(snapshot)).toBe(true);
    trainSearchGet(secondProcess, "second-process", "B");
    expect(secondProcess.commonPaths()).toHaveLength(0);
  });

  test("keeps serialized pre-pattern evidence within its byte budget", () => {
    const learner = new FusionLearner({ maxPersistedEvidenceBytes: 512 });
    for (let index = 0; index < 20; index++) {
      learner.observe({
        sessionId: `budget-${index}`,
        tool: `search-${index}`,
        input: {},
        output: { id: `private-${index}` },
        outcome: "success",
      });
      learner.observe({
        sessionId: `budget-${index}`,
        tool: "get",
        input: { id: `private-${index}` },
        outcome: "success",
      });
      learner.finishSession(`budget-${index}`);
    }

    const snapshot = learner.snapshot();
    expect(snapshot.version).toBe(2);
    if (snapshot.version !== 2) throw new Error("Expected a version-two snapshot");
    expect(Buffer.byteLength(JSON.stringify(snapshot.pools), "utf8")).toBeLessThanOrEqual(512);
    expect(JSON.stringify(snapshot)).not.toContain("private-");
    expect(new FusionLearner().restore(snapshot)).toBe(true);
  });

  test("restores legacy version-one snapshots", () => {
    const original = new FusionLearner();
    trainSearchGet(original, "one", "A");
    trainSearchGet(original, "two", "B");
    const current = original.snapshot();
    const legacy = {
      version: 1 as const,
      sequence: current.sequence,
      ppm: current.ppm,
      patterns: current.patterns,
    };

    const restored = new FusionLearner();
    expect(restored.restore(legacy)).toBe(true);
    expect(restored.commonPaths()).toContainEqual(
      expect.objectContaining({ tools: ["search", "get"] }),
    );
  });

  test("does not persist one-shot template fragments before promotion", () => {
    const learner = new FusionLearner();
    learner.observe({
      sessionId: "one",
      tool: "search",
      input: {},
      output: { id: "raw-id" },
      outcome: "success",
    });
    learner.observe({
      sessionId: "one",
      tool: "get",
      input: { label: "confidential-prefix-raw-id-confidential-suffix" },
      outcome: "success",
    });

    const serialized = JSON.stringify(learner.snapshot());
    expect(serialized).not.toContain("raw-id");
    expect(serialized).not.toContain("confidential-prefix");
    expect(serialized).not.toContain("confidential-suffix");
  });

  test("promotes a stable template from redacted evidence in a later process", () => {
    const firstProcess = new FusionLearner();
    trainTemplatePath(firstProcess, "one", "alpha");
    const serialized = JSON.stringify(firstProcess.snapshot());
    expect(serialized).not.toContain("private-prefix");
    expect(serialized).not.toContain("alpha");

    const secondProcess = new FusionLearner();
    expect(secondProcess.restore(JSON.parse(serialized))).toBe(true);
    trainTemplatePath(secondProcess, "two", "beta");
    secondProcess.observe({
      sessionId: "probe",
      tool: "search",
      input: {},
      output: { id: "gamma" },
      outcome: "success",
    });

    expect(secondProcess.predict("probe")).toContainEqual(
      expect.objectContaining({
        tool: "get",
        input: { label: "private-prefix-gamma-stable-suffix" },
      }),
    );
  });

  test("counts hashed session support before promoting a sensitive constant", () => {
    let snapshot: ReturnType<FusionLearner["snapshot"]> | undefined;
    for (let index = 1; index <= 4; index++) {
      const learner = new FusionLearner();
      if (snapshot) expect(learner.restore(snapshot)).toBe(true);
      learner.observe({ sessionId: `session-${index}`, tool: "search", input: {}, outcome: "success" });
      learner.observe({
        sessionId: `session-${index}`,
        tool: "shell",
        input: { command: "npm test" },
        outcome: "success",
      });
      learner.finishSession(`session-${index}`);
      snapshot = learner.snapshot();
      if (index < 4) expect(JSON.stringify(snapshot)).not.toContain("npm test");
    }

    expect(JSON.stringify(snapshot)).toContain("npm test");
    const restored = new FusionLearner();
    expect(restored.restore(snapshot)).toBe(true);
    expect(restored.commonPaths()).toHaveLength(0);
    expect(
      restored.learnedPatterns().some(
        (pattern) => pattern.targetTool === "shell" &&
          pattern.bindings['["command"]']?.type === "constant",
      ),
    ).toBe(true);
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
    expect(
      learner.commonPaths(8, { search: "search-v2", get: "get-v1" }),
    ).toHaveLength(0);
  });

  test("does not turn failed calls into reusable fusion paths", () => {
    const learner = new FusionLearner();
    for (const sessionId of ["one", "two"]) {
      learner.observe({
        sessionId,
        tool: "search",
        input: {},
        output: { items: [{ id: sessionId }] },
        outcome: "success",
      });
      learner.observe({
        sessionId,
        tool: "get",
        input: { id: sessionId },
        outcome: "error",
      });
      learner.finishSession(sessionId);
    }

    expect(learner.commonPaths()).toHaveLength(0);
    expect(learner.learnedPatterns()).toHaveLength(0);
  });

  test("omits unrelated older context from an executable fusion path", () => {
    const learner = new FusionLearner();
    for (const [sessionId, id] of [["one", "A"], ["two", "B"]] as const) {
      learner.observe({ sessionId, tool: "noise", input: {}, outcome: "success" });
      learner.observe({
        sessionId,
        tool: "search",
        input: {},
        output: { items: [{ id }] },
        outcome: "success",
      });
      learner.observe({ sessionId, tool: "get", input: { id }, outcome: "success" });
      learner.finishSession(sessionId);
    }

    expect(learner.commonPaths()).toContainEqual(
      expect.objectContaining({ tools: ["search", "get"] }),
    );
    expect(learner.commonPaths().some((path) => path.tools.includes("noise"))).toBe(false);
  });

  test("learns a causal path across different intervening noise tools", () => {
    const learner = new FusionLearner();
    for (const [sessionId, id, noise] of [
      ["one", "A", "telemetry"],
      ["two", "B", "heartbeat"],
    ] as const) {
      learner.observe({
        sessionId,
        tool: "search",
        input: {},
        output: { items: [{ id }] },
        outcome: "success",
      });
      learner.observe({ sessionId, tool: noise, input: {}, outcome: "success" });
      learner.observe({ sessionId, tool: "get", input: { id }, outcome: "success" });
      learner.finishSession(sessionId);
    }

    expect(learner.commonPaths()).toContainEqual(
      expect.objectContaining({ tools: ["search", "get"], dataflowEdges: 1 }),
    );
    expect(
      learner.commonPaths().some(
        (path) => path.tools.includes("telemetry") || path.tools.includes("heartbeat"),
      ),
    ).toBe(false);
  });

  test("exposes causal-subsequence learning as a deterministic ablation", () => {
    const learner = new FusionLearner({ learnCausalSubsequences: false });
    for (const [sessionId, id, noise] of [
      ["one", "A", "telemetry"],
      ["two", "B", "heartbeat"],
    ] as const) {
      learner.observe({
        sessionId,
        tool: "search",
        input: {},
        output: { items: [{ id }] },
        outcome: "success",
      });
      learner.observe({ sessionId, tool: noise, input: {}, outcome: "success" });
      learner.observe({ sessionId, tool: "get", input: { id }, outcome: "success" });
      learner.finishSession(sessionId);
    }

    expect(learner.commonPaths()).not.toContainEqual(
      expect.objectContaining({ tools: ["search", "get"] }),
    );
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

function trainTemplatePath(learner: FusionLearner, sessionId: string, id: string): void {
  learner.observe({
    sessionId,
    tool: "search",
    input: {},
    output: { id },
    outcome: "success",
  });
  learner.observe({
    sessionId,
    tool: "get",
    input: { label: `private-prefix-${id}-stable-suffix` },
    outcome: "success",
  });
  learner.finishSession(sessionId);
}

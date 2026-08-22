import { describe, expect, test } from "vitest";
import {
  applyBindingsPartial,
  bindingDependencies,
  inferStableBindings,
} from "../src/learning/bindings.js";
import type { ToolEvent } from "../src/learning/types.js";

describe("structured binding inference", () => {
  test("learns a later argument from authoritative structured output", () => {
    const samples = [
      sample("one", "A"),
      sample("two", "B"),
    ];
    const inferred = inferStableBindings(samples, {
      minimumReplayProbability: 0.75,
      minimumConstantSupport: 4,
    });
    const probe = event({
      sessionId: "probe",
      tool: "search",
      input: { query: "open" },
      output: { items: [{ id: "C" }] },
    });

    expect(applyBindingsPartial(inferred.bindings, [probe], inferred.missing)).toEqual({
      input: { id: "C", view: "compact" },
      missing: [["api_token"]],
    });
    expect(bindingDependencies(inferred.bindings)).toContainEqual({
      targetPath: ["id"],
      sources: [{ relativeEvent: -1, field: "output", path: ["items", 0, "id"] }],
    });
  });

  test("does not memorize credentials as constants or bindings", () => {
    const samples = [sample("one", "A", "secret-one"), sample("two", "B", "secret-two")];
    const inferred = inferStableBindings(samples, {
      minimumReplayProbability: 0.5,
      minimumConstantSupport: 1,
    });

    expect(inferred.missing).toContainEqual(["api_token"]);
    expect(inferred.bindings).not.toHaveProperty('["api_token"]');
  });

  test("replays a stable string template across held-out data", () => {
    const samples = ["alpha", "beta"].map((name) => ({
      context: [
        event({
          sessionId: name,
          tool: "inspect",
          input: {},
          output: { name },
        }),
      ],
      target: event({
        sessionId: name,
        tool: "shell",
        input: { command: `test ${name}.spec.ts` },
      }),
    }));
    const inferred = inferStableBindings(samples, {
      minimumReplayProbability: 1,
      minimumConstantSupport: 4,
    });
    const probe = event({
      sessionId: "probe",
      tool: "inspect",
      input: {},
      output: { name: "gamma" },
    });

    expect(applyBindingsPartial(inferred.bindings, [probe], inferred.missing).input).toEqual({
      command: "test gamma.spec.ts",
    });
  });

  test("rejects a structural binding that does not meet the replay threshold", () => {
    const samples = [
      {
        context: [event({ sessionId: "one", tool: "search", input: {}, output: { id: "A" } })],
        target: event({ sessionId: "one", tool: "get", input: { id: "A" } }),
      },
      {
        context: [event({ sessionId: "two", tool: "search", input: {}, output: { id: "B" } })],
        target: event({ sessionId: "two", tool: "get", input: { id: "different" } }),
      },
    ];
    const inferred = inferStableBindings(samples, {
      minimumReplayProbability: 0.75,
      minimumConstantSupport: 4,
    });

    expect(inferred.bindings).not.toHaveProperty('["id"]');
    expect(inferred.missing).toContainEqual(["id"]);
  });
});

function sample(sessionId: string, id: string, apiToken = "stable-secret") {
  return {
    context: [
      event({
        sessionId,
        tool: "search",
        input: { query: "open" },
        output: { items: [{ id }], api_token: apiToken },
      }),
    ],
    target: event({
      sessionId,
      tool: "get",
      input: { id, view: "compact", api_token: apiToken },
    }),
  };
}

function event(input: {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  output?: unknown;
}): ToolEvent {
  return {
    sessionId: input.sessionId,
    tool: input.tool,
    input: input.input,
    ...(input.output !== undefined ? { output: input.output } : {}),
    outcome: "success",
    durationMs: 5,
    sequence: 1,
  };
}

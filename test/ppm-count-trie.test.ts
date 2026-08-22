import { describe, expect, test } from "vitest";
import { PpmCountTrie } from "../src/learning/ppm-count-trie.js";

describe("PpmCountTrie", () => {
  test("counts the root and every bounded suffix exactly once", () => {
    const model = new PpmCountTrie(2);
    model.observe(["old", "recent", "latest"], "read", 7);

    expect(model.snapshot()).toEqual([
      { context: [], counts: { read: 1 }, lastSeen: 7 },
      { context: ["recent", "latest"], counts: { read: 1 }, lastSeen: 7 },
      { context: ["latest"], counts: { read: 1 }, lastSeen: 7 },
    ]);
  });

  test("uses the longest matching suffix to disambiguate a shared unigram", () => {
    const model = new PpmCountTrie(2);
    for (let index = 0; index < 8; index++) model.observe(["grep", "success"], "read", index);
    for (let index = 0; index < 8; index++) model.observe(["edit", "success"], "shell", index + 8);

    expect(model.probability(["grep", "success"], "read")).toBeGreaterThan(0.8);
    expect(model.probability(["grep", "success"], "read")).toBeGreaterThan(
      model.probability(["grep", "success"], "shell") ?? 1,
    );
    expect(model.estimate(["grep", "success"], "read")?.order).toBe(2);
  });

  test("escapes to a shorter suffix and decays stale evidence", () => {
    const model = new PpmCountTrie(2);
    model.setCount([], "read", 10, 10);
    model.setCount([], "find", 4, 28);
    model.setCount(["grep"], "read", 10, 10);
    model.setCount(["grep"], "find", 4, 28);

    expect(model.probability(["new", "grep"], "read", 30, 0)).toBeGreaterThan(
      model.probability(["new", "grep"], "find", 30, 0) ?? 1,
    );
    expect(model.probability(["new", "grep"], "find", 30, 8)).toBeGreaterThan(
      model.probability(["new", "grep"], "read", 30, 8) ?? 1,
    );
  });

  test("restores deterministic snapshots and ignores malformed rows", () => {
    const original = new PpmCountTrie(2);
    original.observe(["search"], "get", 2);
    original.observe(["search"], "get", 3);
    const restored = new PpmCountTrie(2);
    restored.restore([
      ...original.snapshot(),
      null,
      { context: ["too", "deep", "context"], counts: { bad: 2 } },
      { context: ["search"], counts: { bad: -1 } },
    ]);

    expect(restored.snapshot()).toEqual(original.snapshot());
  });
});

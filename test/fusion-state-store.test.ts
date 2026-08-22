import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FusionLearner } from "../src/learning/fusion-learner.js";
import { FusionStateAutosave } from "../src/persistence/fusion-state-autosave.js";
import { FusionStateStore } from "../src/persistence/fusion-state-store.js";

describe("FusionStateStore", () => {
  let directory: string;
  let statePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codemode-state-test-"));
    statePath = resolve(directory, "nested", "fusion-state.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("atomically saves and restores learned paths without raw trace values", async () => {
    const original = trainedLearner();
    const store = new FusionStateStore(statePath);
    await store.save(original);
    // A second replace verifies cross-platform overwrite behavior as well as creation.
    await store.save(original);

    const serialized = await readFile(statePath, "utf8");
    expect(serialized).not.toContain("private-alpha-id");
    expect(serialized).not.toContain("private-beta-id");
    expect(serialized).toContain("codemode-fusion-state");

    const restored = new FusionLearner();
    await expect(store.load(restored)).resolves.toEqual(
      expect.objectContaining({ status: "loaded" }),
    );
    expect(restored.commonPaths()).toContainEqual(
      expect.objectContaining({ tools: ["docs::search", "docs::get"] }),
    );
  });

  test("treats absent and malformed state as recoverable startup states", async () => {
    const store = new FusionStateStore(statePath);
    await expect(store.load(new FusionLearner())).resolves.toEqual({ status: "missing" });

    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, "{not-json", "utf8");
    await expect(store.load(new FusionLearner())).resolves.toEqual({
      status: "invalid",
      reason: "State file is not valid JSON",
    });
  });

  test("debounces updates and flushes the final snapshot on close", async () => {
    const learner = trainedLearner();
    const store = new FusionStateStore(statePath);
    const save = vi.spyOn(store, "save");
    const autosave = new FusionStateAutosave(store, learner, { debounceMs: 60_000 });

    autosave.schedule();
    autosave.schedule();
    autosave.schedule();
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);

    autosave.schedule();
    await autosave.close();
    expect(save).toHaveBeenCalledTimes(2);
  });
});

function trainedLearner(): FusionLearner {
  const learner = new FusionLearner();
  for (const [sessionId, id] of [
    ["one", "private-alpha-id"],
    ["two", "private-beta-id"],
  ] as const) {
    learner.observe({
      sessionId,
      tool: "docs::search",
      schemaHash: "search-v1",
      input: { query: sessionId },
      output: { items: [{ id }] },
      outcome: "success",
    });
    learner.observe({
      sessionId,
      tool: "docs::get",
      schemaHash: "get-v1",
      input: { id },
      output: { title: sessionId },
      outcome: "success",
    });
  }
  return learner;
}

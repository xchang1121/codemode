import { FusionLearner, eventToken } from "../dist/index.js";

const variants = [
  {
    name: "legacy",
    settings: {
      persistBindingEvidence: false,
      learnCausalSubsequences: false,
      indexToolSuffixes: false,
    },
    batchAware: true,
  },
  {
    name: "+ restart evidence",
    settings: {
      persistBindingEvidence: true,
      learnCausalSubsequences: false,
      indexToolSuffixes: false,
    },
    batchAware: true,
  },
  {
    name: "+ causal subsequences",
    settings: {
      persistBindingEvidence: true,
      learnCausalSubsequences: true,
      indexToolSuffixes: false,
    },
    batchAware: true,
  },
  {
    name: "full (PPM order 4 + 2 tries)",
    settings: {
      persistBindingEvidence: true,
      learnCausalSubsequences: true,
      indexToolSuffixes: true,
    },
    batchAware: true,
  },
  {
    name: "full, PPM order 1",
    settings: {
      maxOrder: 1,
      persistBindingEvidence: true,
      learnCausalSubsequences: true,
      indexToolSuffixes: true,
    },
    batchAware: true,
  },
  {
    name: "full, no batch semantics",
    settings: {
      persistBindingEvidence: true,
      learnCausalSubsequences: true,
      indexToolSuffixes: true,
    },
    batchAware: false,
  },
];

const accuracy = variants.map(evaluateVariant);
const scale = benchmarkToolSuffixIndex();
const report = {
  methodology: {
    positiveCases: ["clean", "restart", "causal-gap", "three-step"],
    negativeCases: ["unrelated-adjacency", "parallel-siblings", "schema-drift"],
    learningTimingEpisodes: 200,
    scalePatterns: scale.patterns,
    scaleQueriesPerRound: scale.queriesPerRound,
  },
  accuracy,
  toolSuffixIndex: scale,
};

const full = accuracy.find((item) => item.name === "full (PPM order 4 + 2 tries)");
if (!full || full.precision !== 1 || full.recall !== 1 || full.bindingAccuracy !== 1) {
  throw new Error("Full learner failed the deterministic ablation corpus");
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("CodeMode learning ablation (deterministic synthetic corpus)\n");
  console.table(
    accuracy.map((item) => ({
      variant: item.name,
      precision: item.precision.toFixed(3),
      recall: item.recall.toFixed(3),
      F1: item.f1.toFixed(3),
      bindings: item.bindingAccuracy.toFixed(3),
      restart: item.restartLearned ? "pass" : "miss",
      gap: item.gapLearned ? "pass" : "miss",
      parallelFP: item.parallelFalsePositive ? "yes" : "no",
      restartEpisodes: item.restartEpisodes ?? ">4",
      learnMs: item.learningMs.toFixed(1),
      stateKiB: (item.stateBytes / 1024).toFixed(1),
    })),
  );
  console.log("\nTool-context suffix index scale ablation");
  console.table([
    {
      mode: "linear scan",
      patterns: scale.patterns,
      medianMs: scale.linearMedianMs.toFixed(2),
      queriesPerSecond: scale.linearQueriesPerSecond.toFixed(0),
    },
    {
      mode: "suffix trie",
      patterns: scale.patterns,
      medianMs: scale.trieMedianMs.toFixed(2),
      queriesPerSecond: scale.trieQueriesPerSecond.toFixed(0),
    },
  ]);
  console.log(`Trie speedup: ${scale.speedup.toFixed(2)}x`);
}

function evaluateVariant(variant) {
  const cases = [
    { name: "clean", expected: true, ...cleanCase(variant.settings) },
    { name: "restart", expected: true, ...restartCase(variant.settings) },
    { name: "causal-gap", expected: true, ...gapCase(variant.settings) },
    { name: "three-step", expected: true, ...threeStepCase(variant.settings) },
    { name: "unrelated-adjacency", expected: false, ...unrelatedCase(variant.settings) },
    {
      name: "parallel-siblings",
      expected: false,
      ...parallelCase(variant.settings, variant.batchAware),
    },
    { name: "schema-drift", expected: false, ...schemaDriftCase(variant.settings) },
  ];
  const truePositive = cases.filter((item) => item.expected && item.detected).length;
  const falsePositive = cases.filter((item) => !item.expected && item.detected).length;
  const falseNegative = cases.filter((item) => item.expected && !item.detected).length;
  const precision = truePositive + falsePositive > 0
    ? truePositive / (truePositive + falsePositive)
    : 1;
  const recall = truePositive / (truePositive + falseNegative);
  const bindingCases = cases.filter((item) => item.expected && item.bindingChecked);
  const bindingAccuracy = bindingCases.length
    ? bindingCases.filter((item) => item.bindingCorrect).length / bindingCases.length
    : 0;
  const timing = benchmarkLearning(variant.settings);
  return {
    name: variant.name,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    bindingAccuracy,
    restartLearned: cases.find((item) => item.name === "restart")?.detected ?? false,
    gapLearned: cases.find((item) => item.name === "causal-gap")?.detected ?? false,
    parallelFalsePositive:
      cases.find((item) => item.name === "parallel-siblings")?.detected ?? false,
    restartEpisodes: episodesToRestartHint(variant.settings),
    learningMs: timing.elapsedMs,
    stateBytes: timing.stateBytes,
    cases: Object.fromEntries(
      cases.map((item) => [item.name, { expected: item.expected, detected: item.detected }]),
    ),
  };
}

function cleanCase(settings) {
  const learner = new FusionLearner(settings);
  trainSearchGet(learner, "clean-1", "A");
  trainSearchGet(learner, "clean-2", "B");
  const detected = hasPath(learner, ["search", "get"]);
  learner.observe(searchObservation("clean-probe", "C"));
  const candidate = learner.predict("clean-probe").find((item) => item.tool === "get");
  return {
    detected,
    bindingChecked: true,
    bindingCorrect: candidate?.input?.id === "C" && candidate.missing.length === 0,
  };
}

function restartCase(settings) {
  const first = new FusionLearner(settings);
  trainSearchGet(first, "restart-1", "A");
  const second = new FusionLearner(settings);
  if (!second.restore(first.snapshot())) throw new Error("Could not restore ablation snapshot");
  trainSearchGet(second, "restart-2", "B");
  const detected = hasPath(second, ["search", "get"]);
  second.observe(searchObservation("restart-probe", "C"));
  const candidate = second.predict("restart-probe").find((item) => item.tool === "get");
  return {
    detected,
    bindingChecked: true,
    bindingCorrect: candidate?.input?.id === "C" && candidate.missing.length === 0,
  };
}

function gapCase(settings) {
  const learner = new FusionLearner(settings);
  for (const [sessionId, id, noise] of [
    ["gap-1", "A", "telemetry"],
    ["gap-2", "B", "heartbeat"],
  ]) {
    learner.observe(searchObservation(sessionId, id));
    learner.observe({ sessionId, tool: noise, input: {}, outcome: "success" });
    learner.observe({ sessionId, tool: "get", input: { id }, outcome: "success" });
    learner.finishSession(sessionId);
  }
  const detected = hasPath(learner, ["search", "get"]);
  learner.observe(searchObservation("gap-probe", "C"));
  const candidate = learner.predict("gap-probe").find((item) => item.tool === "get");
  return {
    detected,
    bindingChecked: true,
    bindingCorrect: candidate?.input?.id === "C" && candidate.missing.length === 0,
  };
}

function threeStepCase(settings) {
  const learner = new FusionLearner(settings);
  for (const [sessionId, id, title] of [
    ["chain-1", "A", "Alpha"],
    ["chain-2", "B", "Beta"],
  ]) {
    learner.observe(searchObservation(sessionId, id));
    learner.observe({
      sessionId,
      tool: "get",
      input: { id },
      output: { title },
      outcome: "success",
    });
    learner.observe({ sessionId, tool: "send", input: { text: title }, outcome: "success" });
    learner.finishSession(sessionId);
  }
  return {
    detected: hasPath(learner, ["search", "get", "send"]),
    bindingChecked: false,
    bindingCorrect: false,
  };
}

function unrelatedCase(settings) {
  const learner = new FusionLearner(settings);
  for (const [sessionId, outputId, inputId] of [
    ["unrelated-1", "result-alpha", "manual-one"],
    ["unrelated-2", "result-beta", "manual-two"],
  ]) {
    learner.observe(searchObservation(sessionId, outputId));
    learner.observe({ sessionId, tool: "get", input: { id: inputId }, outcome: "success" });
    learner.finishSession(sessionId);
  }
  return {
    detected: hasPath(learner, ["search", "get"]),
    bindingChecked: false,
    bindingCorrect: false,
  };
}

function parallelCase(settings, batchAware) {
  const learner = new FusionLearner(settings);
  for (const [sessionId, id] of [["parallel-1", "A"], ["parallel-2", "B"]]) {
    const producer = {
      sessionId,
      turnId: `${sessionId}-batch`,
      tool: "produce",
      input: {},
      output: { id },
      outcome: "success",
    };
    const consumer = {
      sessionId,
      turnId: `${sessionId}-batch`,
      tool: "consume",
      input: { id },
      outcome: "success",
    };
    if (batchAware) learner.observeBatch([producer, consumer]);
    else {
      learner.observe(producer);
      learner.observe(consumer);
    }
    learner.finishSession(sessionId);
  }
  return {
    detected: hasPath(learner, ["produce", "consume"]),
    bindingChecked: false,
    bindingCorrect: false,
  };
}

function schemaDriftCase(settings) {
  const learner = new FusionLearner(settings);
  for (const [sessionId, id] of [["schema-1", "A"], ["schema-2", "B"]]) {
    learner.observe({ ...searchObservation(sessionId, id), schemaHash: "search-v1" });
    learner.observe({
      sessionId,
      tool: "get",
      schemaHash: "get-v1",
      input: { id },
      outcome: "success",
    });
    learner.finishSession(sessionId);
  }
  return {
    detected: hasPath(learner, ["search", "get"], {
      search: "search-v1",
      get: "get-v2",
    }),
    bindingChecked: false,
    bindingCorrect: false,
  };
}

function episodesToRestartHint(settings) {
  let snapshot;
  for (let episode = 1; episode <= 4; episode++) {
    const learner = new FusionLearner(settings);
    if (snapshot && !learner.restore(snapshot)) throw new Error("Restart restore failed");
    trainSearchGet(learner, `episode-${episode}`, `id-${episode}`);
    if (hasPath(learner, ["search", "get"])) return episode;
    snapshot = learner.snapshot();
  }
  return null;
}

function benchmarkLearning(settings) {
  const learner = new FusionLearner(settings);
  const start = performance.now();
  for (let index = 0; index < 200; index++) {
    const sessionId = `timing-${index}`;
    const id = `result-${index}`;
    learner.observe(searchObservation(sessionId, id));
    learner.observe({
      sessionId,
      tool: `noise-${index % 4}`,
      input: { sample: index },
      outcome: "success",
    });
    learner.observe({ sessionId, tool: "get", input: { id }, outcome: "success" });
    learner.finishSession(sessionId);
  }
  return {
    elapsedMs: performance.now() - start,
    stateBytes: Buffer.byteLength(JSON.stringify(learner.snapshot())),
  };
}

function benchmarkToolSuffixIndex() {
  const pairs = 2_000;
  const patterns = syntheticPatterns(pairs);
  const snapshot = {
    version: 1,
    sequence: 20,
    ppm: [
      { context: [], counts: { "middle-0": 20 }, lastSeen: 20 },
      {
        context: [eventToken({ tool: "seed-0", outcome: "success" })],
        counts: { "middle-0": 20 },
        lastSeen: 20,
      },
    ],
    patterns,
  };
  const queriesPerRound = 500;
  const linearMedianMs = medianQueryRound(snapshot, false, queriesPerRound);
  const trieMedianMs = medianQueryRound(snapshot, true, queriesPerRound);
  return {
    patterns: patterns.length,
    queriesPerRound,
    linearMedianMs,
    trieMedianMs,
    linearQueriesPerSecond: (queriesPerRound * 1_000) / linearMedianMs,
    trieQueriesPerSecond: (queriesPerRound * 1_000) / trieMedianMs,
    speedup: linearMedianMs / trieMedianMs,
  };
}

function medianQueryRound(snapshot, indexToolSuffixes, queriesPerRound) {
  const learner = new FusionLearner({
    maxPatterns: snapshot.patterns.length + 8,
    maxSuggestions: 8,
    indexToolSuffixes,
  });
  if (!learner.restore(snapshot)) throw new Error("Could not restore scale fixture");
  learner.observe({
    sessionId: "scale-probe",
    tool: "seed-0",
    input: {},
    output: { id: "probe" },
    outcome: "success",
  });
  for (let index = 0; index < 20; index++) learner.predictPaths("scale-probe");
  const rounds = [];
  for (let round = 0; round < 5; round++) {
    const start = performance.now();
    for (let index = 0; index < queriesPerRound; index++) {
      learner.predictPaths("scale-probe");
    }
    rounds.push(performance.now() - start);
  }
  return rounds.sort((left, right) => left - right)[Math.floor(rounds.length / 2)];
}

function syntheticPatterns(pairs) {
  const result = [];
  for (let index = 0; index < pairs; index++) {
    const seed = `seed-${index}`;
    const middle = `middle-${index}`;
    const final = `final-${index}`;
    result.push(pattern(`first-${index}`, seed, middle));
    result.push(pattern(`second-${index}`, middle, final));
  }
  return result;
}

function pattern(id, contextTool, targetTool) {
  return {
    id,
    context: [eventToken({ tool: contextTool, outcome: "success" })],
    contextTools: [contextTool],
    targetTool,
    bindings: {
      '["id"]': {
        type: "event",
        relativeEvent: -1,
        field: "output",
        path: ["id"],
      },
    },
    missing: [],
    occurrences: 10,
    replayProbability: 1,
    averageDurationMs: 1,
    lastSeenSequence: 20,
  };
}

function trainSearchGet(learner, sessionId, id) {
  learner.observe(searchObservation(sessionId, id));
  learner.observe({ sessionId, tool: "get", input: { id }, outcome: "success" });
  learner.finishSession(sessionId);
}

function searchObservation(sessionId, id) {
  return {
    sessionId,
    tool: "search",
    input: { query: "open" },
    output: { items: [{ id }] },
    outcome: "success",
  };
}

function hasPath(learner, tools, schemaHashes = {}) {
  return learner
    .commonPaths(32, schemaHashes)
    .some((path) => arraysEqual(path.tools, tools));
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

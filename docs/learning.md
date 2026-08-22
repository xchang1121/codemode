# PPM, suffix-trie and binding learning

The learning layer answers two separate questions:

1. Which tool is likely to follow this recent tool history?
2. Can that later call's arguments be reconstructed from earlier structured
   inputs or results?

Control-flow probability alone is not enough for fusion. Two tools may often be
adjacent while still requiring unrelated user input. `codemode` emits a path
only when structural replay demonstrates actual data flow.

## Observation tokens

Each authoritative registry trace becomes a bounded event containing:

- session and optional call/batch identity;
- stable tool ID;
- input and structured output;
- success/error outcome;
- schema hash, duration and sequence metadata.

Context tokens are stable encodings of tool ID, outcome and schema hash. Values
are never part of a PPM token, which keeps the control model compact and avoids
memorizing result content there.

Independent calls observed in one batch are sorted canonically. They share the
same prior history during learning, so one sibling is not treated as the cause
of another.

## Bounded PPM count trie

The count trie stores successor counts for suffix contexts up to `maxOrder`.
Estimation starts from the longest available suffix. If evidence for a target
is absent or weak, an escape probability backs off to the next-shorter suffix,
eventually reaching the order-zero distribution.

Counts use sequence-based half-life decay. This lets recurring recent paths
overtake stale behavior without a periodic full-model rebuild. Trie rows and
their child maps are bounded and trimmed according to the configured pattern
budget.

PPM answers “what probably follows?” It does not authorize or execute that
tool.

## Predictive suffix trie

Learned concrete patterns are indexed separately by their context-token suffix.
At prediction time, the trie returns pattern IDs for matching suffixes from the
most specific retained context down to shorter fallbacks. This avoids scanning
every pattern for each tool result.

The tool schema hash is checked again before a candidate or common path is
shown. A target schema change therefore suppresses stale persisted bindings.

## Structural binding inference

For a repeated context/target pair, inputs and structured outputs are flattened
into safe JSON paths. The learner tries to replay every target input leaf from:

- a prior event input path;
- a prior event output path;
- a stable string template around one of those sources;
- `normalizePath`, `dirname` or `basename` transforms; or
- a learned path join of two sources.

A binding survives only if it replays across the configured fraction of
samples. Unbound target fields remain explicit `missing` paths in the generated
skeleton; the model must fill them from the current task.

Provenance-sensitive constants such as commands, paths, queries and text use a
higher support threshold than event bindings. Simple stable non-secret constants
can be retained at ordinary pattern support. Paths with unsafe prototype segments
or credential-like names are excluded. Presentation text is not parsed as a
substitute for `structuredContent`.

Example learned binding:

```text
context tool: docs::search
target tool:  docs::get

target input ["id"] = event(-1).output["items"][0]["id"]
```

Rendered Code Mode skeleton:

```js
const input1 = { /* current-task search arguments */ };
const step1 = await tools["docs"]["search"](input1);
const input2 = {};
codemode.set(input2, ["id"], step1["items"][0]["id"]);
const step2 = await tools["docs"]["get"](input2);
return step2;
```

## Multi-step paths

The path frontier starts with current-session PPM candidates or reliable global
patterns. It expands by matching each provisional tool suffix against retained
patterns. An added step must introduce another earlier-output dependency; plain
workflow adjacency does not make a path longer.

The beam is bounded by per-tool width, maximum suggestions and maximum path
depth. Scores combine path probability and observed duration, while final
ordering favors useful longer data-flow paths.

## Active hints

After a direct call, the gateway asks the learner for paths matching that
session's new suffix. Rendered hints include:

- readable tool sequence and confidence;
- number of learned data-flow edges; and
- an executable JavaScript skeleton with explicit missing fields.

Common paths also appear in `codemode_search`, `codemode_suggest` and refreshed
direct-tool descriptions. The hint is advice to the model, never automatic
speculative execution.

## Persistence

Snapshots contain:

- bounded PPM trie rows;
- learned structural patterns; and
- the monotonic sequence number.

Session histories, sample pools and raw output values are intentionally absent.
Stable non-secret constants that became bindings may still be present. Restore
rebuilds the suffix index lazily and resumes PPM estimates without pretending
that a previous process's conversation is still active.

## Relationship to Pi speculative-action

The bounded PPM count-trie, suffix matching and structural binding ideas are
adapted from the
[`speculative-action` branch of `xchang1121/pi`](https://github.com/xchang1121/pi/tree/speculative-action).

Pi uses those predictions as part of a broader speculative-action system with
workspace isolation, provenance checks and reconciliation. This repository
ports only the learning concepts needed to identify and explain likely tool
fusion paths. It does not pre-execute predicted tools and does not require Pi.

## Main tuning knobs

| Setting | Default | Effect |
| --- | ---: | --- |
| `maxOrder` | 4 | Longest retained tool-history suffix. |
| `minimumOccurrences` | 2 | Samples required before rebuilding a structural pattern. |
| `minimumBindingReplayProbability` | 0.75 | Required fraction of successful binding replays. |
| `minimumConstantSupport` | 4 | Session support required for provenance-sensitive constants. |
| `decayHalfLifeEvents` | 2048 | Sequence-distance half-life for PPM counts. |
| `maxPathDepth` | 4 | Maximum number of learned target steps to unfold. |

The full defaults are exported as `FUSION_LEARNER_DEFAULTS`.

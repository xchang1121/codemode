# Learning ablation

Run the deterministic accuracy, sample-efficiency and scale benchmark with:

```bash
npm run bench:learning
```

Use `node scripts/learning-ablation.mjs --json` after `npm run build` for a
machine-readable report. The benchmark does not call a model, network service
or external MCP server.

## Corpus and metrics

Four positive cases test a clean two-step dependency, two observations split
across process restarts, a dependency separated by different noise tools, and
a three-step path. Three negative cases test unrelated sequential arguments,
independent batch siblings with matching-looking values, and a stale target
schema. Precision, recall and F1 use exact tool paths. Binding accuracy also
requires a held-out output value to reconstruct the later input exactly.

The restart metric creates a new learner for every episode. The scale metric
loads 4,000 valid patterns, holds the event-token trie constant, and toggles
only the tool-context suffix index used by beam expansion.

## Reference result

This reference run used Windows, Node.js 20.17.0, and the default learner
thresholds on 2026-08-22. Accuracy and episode counts are deterministic;
wall-clock values should be remeasured on the deployment machine.

| Variant | Precision | Recall | F1 | Binding accuracy | Restart | Gap | Parallel false positive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy: promoted rules only, contiguous contexts, linear expansion | 1.000 | 0.500 | 0.667 | 0.333 | >4 episodes | miss | no |
| + redacted restart evidence | 1.000 | 0.750 | 0.857 | 0.667 | 2 episodes | miss | no |
| + causal subsequences | 1.000 | 1.000 | 1.000 | 1.000 | 2 episodes | pass | no |
| Full: PPM order 4 + event/tool tries | 1.000 | 1.000 | 1.000 | 1.000 | 2 episodes | pass | no |
| Full with PPM order 1 | 1.000 | 0.750 | 0.857 | 0.667 | 2 episodes | miss | no |
| Full without batch semantics | 0.800 | 1.000 | 0.889 | 1.000 | 2 episodes | pass | **yes** |

Across three consecutive runs, 500 repeated path queries over 4,000 patterns
measured a **3.77×–3.99× speedup** from the second suffix trie. The final run was
64.78 ms for a linear scan versus 17.17 ms for the trie. On that run, the
200-episode learning workload took 45.9 ms for the full learner versus 41.6 ms
for the legacy variant. Its snapshot was 90.7 KiB versus 5.1 KiB because it
retained bounded hash evidence for unpromoted pools.

## Interpretation

Redacted evidence is the sample-efficiency change: it turns a common MCP
lifecycle from “never reaches two samples” into a rule learned on the second
process. Causal subsequences recover dependencies across interleaved calls; an
order-one context cannot see across that gap. Batch semantics are a precision
requirement rather than an optimization. The second trie does not change
accuracy, but removes a pattern-count-dependent scan from every expansion.

The default combines all four properties. Each feature remains independently
switchable through `FusionLearnerSettings` and JSON configuration so a host can
repeat the ablation on its own traces and privacy constraints.

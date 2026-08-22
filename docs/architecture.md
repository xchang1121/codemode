# Architecture

`codemode` is a northbound MCP server and a southbound MCP client. An existing
ReAct agent keeps using normal MCP calls; Code Mode adds one program-shaped
execution scope without requiring a framework patch or model-specific API.

The architecture follows the central Code Mode seam used by
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the code
runtime executes a program against host-provided async bindings, but has no
knowledge of tools, MCP, sessions or learning. The tool layer creates those
bindings for one run and sends every subcall through the authoritative registry.

## Dependency shape

```text
MCP / ReAct client
        │
        ▼
CodeModeGateway                         northbound MCP adapter
        │ CodeModeApplicationPort
        ▼
CodeModeService                         transport-neutral use cases
   ├── Code Mode contract               names + schemas + parser + instructions
   ├── CodeModeToolRegistryPort ───────► ToolRegistry ─► MCP providers
   ├── CodeExecutor ───────────────────► ToolScopeCodeExecutor
   │                                         │ CodeRuntime
   │                                         ▼
   │                                   QuickJsCodeRuntime
   └── FusionAdvisorPort ──────────────► FusionAdvisor
                                             ├── FusionLearner (PPM + tries)
                                             └── hint renderer

Default composition ── creates and connects the concrete service, advisor,
                       learner, registry-aware executor and lifecycle owners

Runtime composition ── optionally connects FusionStateAutosave
                       to FusionStateStore
```

The dependency arrows point inward through small interfaces. In particular:

- `CodeModeGateway` knows only MCP, the wire contract and the application port.
- `CodeModeService` knows use cases and ports, not QuickJS or the learning algorithm.
- `QuickJsCodeRuntime` knows code and binding trees, not the tool registry.
- `FusionAdvisor` is the sole owner of trace batching, learning queries, hint
  rendering, delivery and the semantic “hints changed” event.
- `composition.ts` is the only Code Mode module that chooses concrete
  implementations.

Architecture tests enforce these import directions so a convenient future
shortcut cannot silently re-couple the layers.

## The model-visible contract

`src/code-mode/contract.ts` is the single source of truth for:

- the four stable MCP names;
- initialization instructions;
- tool descriptions and JSON Schemas;
- defaults and argument bounds; and
- parsing from MCP snake_case fields to internal typed inputs.

The model sees these Code Mode operations:

| Tool | Responsibility |
| --- | --- |
| `codemode_search` | Find a small relevant subset of the upstream catalog and common learned paths. |
| `codemode_describe` | Return exact schemas and generated TypeScript declarations. |
| `codemode_suggest` | Return learned, executable multi-tool skeletons and canonical allowlist IDs. |
| `codemode_execute` | Execute the body of one async JavaScript function. |

`codemode_execute` is the only program transport. Search, describe and suggest
are discovery operations; they never create a second execution mechanism.

## One Code Mode run

```text
model
  │ codemode_execute({ allowed_tools, code })
  ▼
CodeModeService
  │ typed CodeExecutionRequest
  ▼
ToolScopeCodeExecutor
  │ resolve allowlist once
  │ create tools[namespace][name] binding tree
  ▼
CodeRuntime.run({ program, bindings, signal })
  │
  ├─ guest: const found = await tools.docs.search(...)
  │              │
  │              ▼
  │         binding function
  │              ▼
  │         ToolRegistry policy + input validation
  │              ▼
  │         authoritative upstream MCP tool
  │              ▼
  │         output validation + lossless JSON snapshot
  │              │
  │              └──── result returns to guest local variable
  │
  └─ guest: return selectedFinalValue
                 │
                 ▼
model receives { value, logs, toolCalls, durationMs }
```

This is how one tool result becomes another tool's arguments: it is ordinary
program data flow inside one async function. The host does not guess that a
result is an argument and does not serialize it through another model turn.
The model writes the assignment and later `await`; the binding bridge performs
each real call.

Only functions in the explicit allowlist are installed. There is no generic
network, filesystem, process or module bridge. Every installed function still
passes the same registry policy and schema checks as a direct ReAct call.

### Run-scoped behavior

Each execute request creates a fresh scope:

- the allowlist is resolved before the program starts;
- the guest receives null-prototype, frozen binding objects;
- binding arguments and results must be lossless JSON;
- failed subcalls reject as `ToolCallError` inside the program;
- dependent calls are sequenced with `await`;
- calls created in one guest microtask are recorded as one sibling batch;
- independent siblings may overlap within the configured concurrency budget;
- a hard runtime deadline can interrupt a synchronous infinite loop; and
- when the program settles, unawaited calls are cancelled and drained before
  the runtime is disposed.

No guest state survives into the next run.

## Runtime seam

`CodeRuntime` owns the smallest substrate-independent vocabulary:

```ts
interface CodeRuntime {
  readonly language: string;
  readonly isolation: string;
  run(request: {
    program: string;
    bindings: readonly CodeBindingNamespace[];
    signal?: AbortSignal;
  }): Promise<CodeRunResult>;
}
```

Program failures are returned in `CodeRunResult.error`; misuse of the binding
contract rejects `run()`. `ToolScopeCodeExecutor` translates runtime outcomes
to the existing high-level `CodeExecutor` error API.

`QuickJsCodeRuntime` is the current provider. `QuickJsCodeExecutor` remains as
a backwards-compatible convenience composition for embedders that currently
construct it with a `ToolRegistry`.

## Tool registry

`ToolRegistry` gives every upstream tool three identifiers:

- stable internal ID: `namespace::originalName`;
- collision-safe direct MCP name: `namespace__originalName`; and
- JavaScript reference: `tools["namespace"]["originalName"]`.

The registry validates inputs and structured outputs against upstream JSON
Schemas. A host policy runs before every direct or Code Mode subcall.
Invocation observers receive the same authoritative request/result pair that
the caller received.

`McpToolProvider` supports stdio and Streamable HTTP transports through the
official MCP SDK. `InMemoryToolProvider` exposes application functions without
starting another process.

## Normal ReAct call

```text
model -> docs__search(args)
gateway -> application service
service -> registry policy + schema validation
registry -> upstream docs.search(args)
upstream -> structured result
registry trace -> FusionAdvisor
FusionAdvisor -> unchanged result + optional separate hint
model <- result
```

A hint never modifies authoritative `structuredContent`. According to
`gateway.hintDelivery`, it is appended as assistant-audience content, result
`_meta`, both, or neither.

Direct tools are published by default so an ordinary ReAct agent remains fully
usable and supplies authoritative learning traces. Set
`gateway.exposeDirectTools` to `false` for a collapsed Code Mode surface.

## Discovery and guidance

Publishing every upstream schema can consume a large model context. This MCP
gateway therefore uses progressive discovery:

1. search for relevant capabilities;
2. describe only the selected tools;
3. copy their stable IDs into the explicit allowlist; and
4. compose calls inside one program.

The initialization instructions, tool definitions and learned hints are all
derived from the central contract. A model needs no hidden “Code Mode” feature;
it only needs to follow normal MCP documentation.

This differs intentionally from DSH's fully collapsed `run_code` presentation,
which can inject a generated SDK into its own system-prompt assembly. A generic
MCP gateway does not control its client's prompt assembler, so progressive
discovery and an explicit allowlist provide a portable, least-authority form of
the same execution mechanism.

## Learning boundary

`FusionAdvisor` observes registry traces, not model messages. It owns:

- grouping `Promise.all` siblings before observation;
- converting authoritative traces to learner observations;
- PPM/trie prediction and schema-hash invalidation;
- rendering executable fusion paths;
- session and common hint selection;
- content and metadata delivery; and
- change notification plus a contained persistence callback.

The learner cannot train on chain-of-thought text, guessed outputs or code that
never reached a tool. Only successful structured call pairs can become reusable
data-flow patterns. Errors remain context signals but are not fusion examples.

Calls in the same batch are independent siblings and never causal context for
one another. Sequential awaits receive different batches and preserve actual
data-flow order.

MCP has no universal conversation identifier. The contract resolves context in
this order:

1. `_meta["io.github.xchang1121/codemode-session"]`;
2. the transport session ID; or
3. `"default"` for a stdio connection.

Structural replay remains the main false-positive defense. Adjacency alone is
not a fusion path; a replayed earlier-output-to-later-input edge is required.

## Persistence lifecycle

The CLI loads a compact learner envelope before assembling the application.
Version-2 snapshots include value-minimized candidate evidence, allowing short
processes to jointly meet the support threshold without retaining raw call
values. Version-1 pattern-only snapshots remain readable.

The default composition passes one `onLearnerChanged` observer to
`FusionAdvisor`; that observer schedules `FusionStateAutosave`. Persistence
failures are contained and cannot change tool behavior. Shutdown first closes
the gateway/application so no new observations enter, then flushes autosave.

## Evolution boundaries

| Future change | Intended edit surface | Layers that should remain untouched |
| --- | --- | --- |
| Add a Python, process or container backend | Implement `CodeRuntime` and choose it in composition | MCP gateway, service, registry, learner |
| Change QuickJS/WASM limits or bootstrap | `QuickJsCodeRuntime` | protocol, learning, MCP transport |
| Change tool concurrency or subcall policy | `ToolScopeCodeExecutor` / `ToolRegistry` | runtime substrate, gateway, hints |
| Replace PPM/trie learning | Implement `FusionAdvisorPort` or change `FusionAdvisor` | gateway, service, runtime |
| Change persisted learner format | learner/store/autosave | execution and MCP layers |
| Add or revise a Code Mode MCP operation | central contract + one service use case | runtime and learner internals |
| Add another northbound transport | new adapter over `CodeModeApplicationPort` | service, execution, learning |
| Add another upstream tool source | implement `ToolProvider` | Code Mode protocol and runtime |

The rule is practical: a change should move across a port as data or an event,
not by importing the implementation on the other side.

## Extension points

Library consumers can:

- add any `ToolProvider` implementation;
- supply a synchronous or asynchronous `ToolPolicy`;
- implement `CodeRuntime` and compose it through `ToolScopeCodeExecutor`;
- implement `CodeExecutor` directly;
- implement `FusionAdvisorPort`;
- call `CodeModeService` without MCP;
- put another transport in front of `CodeModeApplicationPort`; or
- attach any official MCP server `Transport` to `CodeModeGateway`.

The packaged CLI intentionally keeps the northbound transport to stdio for
maximum desktop-agent compatibility.

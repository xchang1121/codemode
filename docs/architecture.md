# Architecture

`codemode` is a northbound MCP server and a southbound MCP client. The wrapper
is the compatibility boundary: the agent keeps its existing MCP/ReAct loop,
while the gateway owns catalog aggregation, code execution and learning.

## Components

```text
MCP client
   │
   ▼
CodeModeGateway
   ├── ToolRegistry ──► McpToolProvider ──► upstream MCP servers
   ├── QuickJsCodeExecutor
   ├── FusionLearner
   └── FusionStateAutosave ──► FusionStateStore
```

`ToolRegistry` gives every upstream tool three identifiers:

- a stable internal ID, `namespace::originalName`;
- a collision-safe direct MCP name, `namespace__originalName`; and
- a JavaScript reference, `tools["namespace"]["originalName"]`.

The registry validates input and structured output against the upstream JSON
Schemas. A host policy runs before every direct or Code Mode subcall. Invocation
listeners receive the same authoritative request/result pair that the caller
received.

`McpToolProvider` supports stdio and Streamable HTTP upstream transports through
the official TypeScript MCP SDK. `InMemoryToolProvider` is available for hosts
that want to expose application functions without starting another process.

## Normal ReAct call

```text
model -> docs__search(args)
gateway -> registry policy + schema validation
registry -> upstream docs.search(args)
upstream -> structured result
registry -> learner observation
gateway -> unchanged result + optional separate fusion hint
model <- result
```

The appended hint never modifies `structuredContent`. It is either an
assistant-audience text content item, result `_meta`, or both according to
`gateway.hintDelivery`.

## Code Mode call

```text
model -> codemode_execute({ allowed_tools, code })
gateway -> QuickJS/WASM context
guest JS -> host bridge -> registry -> upstream tool
guest JS <- JSON-serializable structured result
guest JS -> loops / branching / filtering / another await
gateway <- final return value only
model <- { value, logs, toolCalls, durationMs }
```

There is no generic network or Node.js bridge. A guest tool function exists
only if the stable tool ID or direct gateway name was present in
`allowed_tools`. Every subcall still passes registry policy and schema checks.

Calls created in the same guest microtask wait on a small batch barrier. This
lets the host label all `Promise.all` siblings with one batch ID and final batch
size before they enter the learner. Sequential `await` calls receive separate
batches and therefore preserve real data-flow order.

## Discovery and model guidance

Publishing every schema can consume a large model context. The gateway instead
offers progressive discovery:

1. `codemode_search` returns compact matches and relevant learned paths.
2. `codemode_describe` returns exact schemas and generated TypeScript for only
   the selected tools.
3. `codemode_execute` exposes only the explicitly selected functions.

The MCP server initialization instructions, tool descriptions and learned
hints all describe this sequence. A model does not need prior Code Mode
training; it only needs to follow normal tool documentation.

## Learning boundary

The learner sees registry traces, not model messages. It therefore cannot learn
from chain-of-thought text, guessed outputs or code that never reached a tool.
Only successful structured call pairs can become a reusable data-flow pattern.
Errors remain context signals for the PPM model but are not fusion examples.

Schema hashes are part of context tokens and target patterns. A persisted path
is suppressed if the current target tool schema no longer matches the schema it
was learned against.

MCP has no universal conversation identifier. The gateway uses, in order:

1. request `_meta["io.github.xchang1121/codemode-session"]` when supplied;
2. the transport session ID when available; or
3. `"default"` for a stdio connection.

Structural binding replay is the main false-positive defense across task
boundaries: ordinary adjacency without an earlier-result-to-later-input edge is
not emitted as a fusion path.

## Persistence lifecycle

The CLI loads one compact learner envelope before constructing the gateway.
Observation callbacks mark state dirty. Debounced saves serialize writes, use a
unique sibling temporary file, and replace the destination only after a full
write. Shutdown first closes the gateway to stop new observations, then flushes
the final state.

Malformed or unsupported state is reported and ignored. I/O failures reading a
configured state path fail startup; background save failures are reported on
stderr and retried during final shutdown.

## Extension points

Library consumers can replace or configure each boundary:

- add any `ToolProvider` implementation;
- supply a synchronous or asynchronous `ToolPolicy`;
- implement another `CodeExecutor` behind the same interface;
- construct `CodeModeGateway` with any MCP server `Transport`; or
- use `FusionLearner` independently of MCP.

The CLI intentionally keeps the northbound transport to stdio for maximum
desktop-agent compatibility. An HTTP host can embed `CodeModeGateway` and pass
the corresponding official MCP server transport.

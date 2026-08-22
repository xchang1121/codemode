# codemode

`codemode` is an MCP gateway for existing ReAct-style agents. It aggregates
ordinary MCP tools, lets a model compose them inside one sandboxed JavaScript
program, and learns which tool paths are worth composing from real structured
tool calls.

The agent does not need a framework patch or a special model API. If it can use
MCP tools, it can use this gateway.

```text
Existing ReAct agent
        │ one MCP connection
        ▼
┌──────────────── codemode gateway ────────────────┐
│ direct tools        Code Mode          learner   │
│ docs__search        search/describe    PPM       │
│ docs__get           execute            trie      │
│                                         bindings │
└───────────┬───────────────────┬──────────────────┘
            ▼                   ▼
       stdio MCP           HTTP MCP
```

The core idea is simple. Instead of making the model return to the ReAct loop
after every tool result, the model can write one program:

```js
const found = await tools.docs.search({ query: "MCP" });
const records = await Promise.all(
  found.items.map(item => tools.docs.get({ id: item.id })),
);
return records.filter(record => record.status === "open");
```

Each `await` still invokes the real authoritative MCP tool. JavaScript only
handles orchestration, branching, loops, filtering and data transfer between
calls.

## Why an MCP gateway?

MCP is the compatibility layer. The gateway appears to an agent as one normal
MCP server and consumes any number of upstream MCP servers. This keeps Code
Mode independent of a particular agent framework, prompt loop or model vendor.

This project is deliberately not speculative execution. It never runs a
predicted side effect in advance. Learned paths are shown as hints; execution
starts only when the model explicitly calls `codemode_execute`.

## Quick start

Requirements: Node.js 20.17 or newer.

```sh
git clone https://github.com/xchang1121/codemode.git
cd codemode
npm ci --ignore-scripts
npm run build
```

Create `codemode.config.json`:

```json
{
  "$schema": "./codemode.config.schema.json",
  "version": 1,
  "servers": {
    "docs": {
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/docs-mcp-server.js"],
      "env": {
        "DOCS_TOKEN": "${DOCS_TOKEN}"
      }
    }
  }
}
```

Check that every upstream server starts and its tool schemas are valid:

```sh
node dist/cli.js --config /absolute/path/to/codemode.config.json --check
```

Then register the gateway in an MCP client. Many clients use a configuration
shape similar to this (the outer key differs between clients):

```json
{
  "mcpServers": {
    "codemode": {
      "command": "node",
      "args": [
        "/absolute/path/to/codemode/dist/cli.js",
        "--config",
        "/absolute/path/to/codemode.config.json"
      ]
    }
  }
}
```

The gateway speaks MCP over stdio on stdout. Diagnostics go only to stderr.

See [examples/codemode.config.json](examples/codemode.config.json) for stdio and
HTTP upstream examples.

## What the agent sees

The server publishes four Code Mode tools:

| Tool | Purpose |
| --- | --- |
| `codemode_search` | Search the upstream catalog and learned paths without loading every schema. |
| `codemode_describe` | Return exact schemas, code references and TypeScript declarations for selected tools. |
| `codemode_suggest` | Return learned multi-tool paths and executable JavaScript skeletons. |
| `codemode_execute` | Run one JavaScript function body with an explicit tool allowlist. |

By default it also publishes upstream tools directly with collision-safe names:

```text
MCP gateway name     stable tool ID      Code Mode reference
docs__search         docs::search        tools["docs"]["search"]
docs__get            docs::get           tools["docs"]["get"]
```

Direct tools are important: an agent can keep using its normal ReAct behavior
while the gateway observes authoritative calls and learns. Set
`gateway.exposeDirectTools` to `false` if only the four Code Mode tools should
be visible.

### How does a model know how to use Code Mode?

No hidden model capability is assumed. The MCP initialization instructions and
tool descriptions explicitly tell the model:

1. search for relevant tools;
2. inspect their exact schemas;
3. put only those tools in `allowed_tools`; and
4. use `await tools[namespace][name](args)` inside `codemode_execute`.

Learned hints reinforce that instruction in three places: direct tool results,
assistant-visible content; result `_meta`; and refreshed tool descriptions
through MCP `tools/list_changed` notifications.

## How learning works

Given repeated successful traces:

```text
docs.search({ query }) -> { items: [{ id: "A" }] }
docs.get({ id: "A" })  -> { ... }
```

the learner combines three signals:

```text
tool history ──► PPM successor probability
      │
      └────────► suffix trie context match

structured inputs/results ──► replayed field bindings
                               search.output.items[0].id
                                      │
                                      ▼
                               get.input.id
```

A path is suggested only when it has replayable structured data flow, not just
because two calls appeared next to each other. The default support threshold is
two matching observations. Independent calls issued together with
`Promise.all` are recorded as siblings and are not treated as causes of one
another. Failed calls remain useful history but are never training examples for
a reusable fusion program.

The learner also:

- uses bounded suffix contexts and decay, so recent repeated behavior matters;
- infers nested fields, stable templates and common path operations;
- rejects credential-like argument paths from learned bindings;
- invalidates a hint when an upstream target tool schema changes; and
- can unfold learned data flow across several tools.

Only real calls and structured results are training evidence. Model reasoning,
generated code and presentation text are not treated as ground truth.

For the full algorithm and its relationship to Pi's speculative-action branch,
see [docs/learning.md](docs/learning.md).

## Configuration

The checked-in [JSON Schema](codemode.config.schema.json) mirrors runtime
validation and enables editor completion. Relative `cwd` and state paths are
resolved from the configuration file's directory.

An HTTP upstream looks like this:

```json
{
  "servers": {
    "remote": {
      "transport": "http",
      "url": "${REMOTE_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${REMOTE_MCP_TOKEN}"
      }
    }
  }
}
```

`${NAME}` placeholders are expanded from the gateway process environment. A
missing variable is a startup error, which prevents accidentally sending the
literal placeholder as a credential.

Important groups:

- `gateway`: direct-tool visibility and proactive hint delivery;
- `execution`: wall-clock, memory, stack, source, result, log, tool-call and
  concurrency budgets;
- `learning`: PPM order/decay, support thresholds and path limits; and
- `state`: durable snapshot path, debounce interval and maximum file size. Use
  `"state": false` to disable persistence.

Defaults are intentionally usable; most installations only need `servers`.

## Sandboxing and security

Code runs in QuickJS compiled to WebAssembly, not in the Node.js host context.
The guest has no `process`, `require`, filesystem module or direct `fetch`.
Only tools named in that request's `allowed_tools` are installed in the guest.
Host-side controls enforce time, memory, stack, source size, result size,
concurrency and call-count budgets.

Those controls contain generated JavaScript; they do not make an upstream tool
safe. `allowed_tools` is an execution scope, not an authorization grant. Keep
real access control in the upstream MCP server or supply a `ToolRegistry`
policy when embedding the library.

Direct tool output remains authoritative. A proactive hint is appended as a
separate assistant-audience content item and/or `_meta`; it never changes
`structuredContent` or claims to be an upstream result.

Durable state does not contain complete tool-call traces or raw output values.
It stores bounded PPM counts, structural source/target paths and learned
patterns. A stable non-secret input constant can be retained; provenance-sensitive
strings such as commands, paths, queries and text require the higher configured
constant-support threshold. Treat the state file as application data, review its
location, and disable persistence if that is not acceptable for the tool set.
Credential-like paths such as tokens, passwords, cookies and authorization fields
are excluded from binding inference.

See [docs/security.md](docs/security.md) for the threat model and operational
guidance.

## Library API

The CLI is built from the same public components. Embedders can use a custom
MCP transport, add an authorization policy, or provide in-process tools:

```ts
import {
  CodeModeGateway,
  InMemoryToolProvider,
  QuickJsCodeExecutor,
  ToolRegistry,
} from "@xchang1121/codemode";

const registry = new ToolRegistry({
  policy: request => request.tool.id === "admin::delete_everything"
    ? { allowed: false, reason: "Destructive tool is unavailable in this host" }
    : { allowed: true },
});

await registry.addProvider(new InMemoryToolProvider("app", [/* tools */]));

const gateway = new CodeModeGateway({
  registry,
  executor: new QuickJsCodeExecutor(registry),
});

await gateway.connect(yourMcpServerTransport);
```

`createCodeModeRuntime()` is the higher-level configuration-driven API used by
the CLI.

## Current scope

- The gateway aggregates MCP tools, not resources or prompts.
- Upstream tool calls must return an immediate MCP tool result; experimental
  task-augmented/long-running tool results are not yet bridged.
- The packaged CLI serves stdio. Library hosts can attach another official MCP
  server transport.
- Code Mode values must be JSON-serializable. Structural learning is strongest
  when upstream tools provide `structuredContent` and `outputSchema`.
- MCP does not define a universal conversation ID. A host can pass
  `_meta["io.github.xchang1121/codemode-session"]`; otherwise the transport
  session, or one default stdio session, is used.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` performs strict TypeScript checking, the unit/integration test
suite, a declaration build, and a real stdio CLI smoke test that crosses both
the northbound and upstream MCP boundaries.

The repository is tested on Windows and Linux. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development expectations.

## Status and attribution

This is an early `0.1.x` implementation. Pin versions and evaluate policies,
resource limits and state handling for your environment before exposing
side-effecting tools.

The bounded PPM count-trie design is adapted from the
[`speculative-action` branch of `xchang1121/pi`](https://github.com/xchang1121/pi/tree/speculative-action).
The original and project licenses are both MIT; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

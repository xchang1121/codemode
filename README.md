# codemode

`codemode` is an MCP gateway that turns ordinary tools into one programmable
Code Mode surface. It also learns recurring tool paths from authoritative calls
and proactively shows an agent which paths are likely to be fused into one code
execution.

The project combines two independent ideas:

1. **Code Mode**: a model writes one JavaScript program whose `await` expressions
   call real tools through a sandboxed host bridge.
2. **Learned fusion hints**: an online PPM model estimates likely successor tools,
   a suffix trie finds the most relevant learned contexts, and structural binding
   inference discovers how an earlier tool result supplies a later tool argument.

```text
ReAct agent
    │ MCP
    ▼
codemode gateway
    ├── direct namespaced tools (observed for learning)
    ├── codemode_search / codemode_describe / codemode_execute
    ├── PPM + suffix trie fusion hints
    └── upstream MCP servers
```

## Development status

The first implementation stage contains the framework-neutral online learning
core. MCP aggregation and sandbox execution are added in the following stages.

```sh
npm install --ignore-scripts
npm run check
```

## Learning behavior

Given repeated authoritative traces such as:

```text
search({ query }) -> { items: [{ id: "A" }] }
get({ id: "A" })  -> ...
```

the learner records both:

- the control-flow relation `search -> get`, including a PPM probability; and
- the data-flow binding `search.output.items[0].id -> get.input.id`.

It can then emit a fusion path and, once the MCP layer is connected, a code
skeleton equivalent to:

```js
const searchResult = await tools.search({ query });
return tools.get({ id: searchResult.items[0].id });
```

Raw model reasoning is never used as training evidence. Only tool calls and
their structured results are observed.

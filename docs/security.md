# Security model

`codemode` executes model-generated JavaScript and invokes external tools. Its
security design therefore treats guest code as untrusted and upstream tool
authorization as a separate boundary.

## Trust boundaries

```text
untrusted model code
        │ narrow host bridge
        ▼
QuickJS/WASM sandbox
        │ explicit allowed_tools
        ▼
ToolRegistry policy and schema validation
        │
        ▼
upstream MCP authorization and side effects
```

Tool results are also untrusted data. They are transferred as JSON values; they
are not evaluated as source code.

## Guest containment

Each execution receives a fresh QuickJS context with configured runtime memory,
stack and interrupt limits. The bootstrap installs:

- selected `tools[namespace][name]` functions;
- safe object-path and path-string helpers under `codemode`; and
- a bounded console collector.

It does not install Node.js globals, module loading, environment access,
filesystem access or direct networking. The host additionally limits source
bytes, wall-clock time, per-tool time, total calls, parallel calls, returned
bytes and log entries.

The tool bridge accepts object arguments only. Registry JSON Schema validation
runs before the upstream call and structured output validation runs afterward.
Prototype-mutating object path segments are rejected by guest helpers and
binding inference.

## Authorization

`allowed_tools` prevents accidental access to tools omitted from one generated
program. It is not user identity or authorization. A model that can see a tool
may place it in `allowed_tools`.

For sensitive tools, enforce authorization in one or both of these places:

1. the upstream MCP server, using its normal user/service identity; and
2. a library-level `ToolRegistry` policy that examines tool ID, arguments,
   session and whether the call is direct or from code.

The JSON CLI intentionally does not define a general policy language. Security
rules are application-specific and are safer as code in an embedding host than
as a deceptively broad allow/deny glob.

## Side effects

The sandbox cannot roll back an upstream tool. If a generated program sends an
email and then fails, the email remains sent. Configure conservative tool
descriptions/annotations, upstream confirmation mechanisms and registry
policies for destructive or externally visible actions.

This project does not speculatively pre-run learned paths. A hint has no side
effect; only an explicit direct call or `codemode_execute` subcall reaches an
upstream tool.

Cancellation is best effort across MCP boundaries. A provider may finish work
after the gateway has timed out if that provider does not honor cancellation.

## Secrets

Use `${ENVIRONMENT_VARIABLE}` placeholders instead of literal credentials in a
committed config. Stdio child processes inherit only the MCP SDK's default safe
environment plus variables explicitly listed under that server's `env` map.
HTTP headers are constructed in memory.

Secret-like target paths are excluded from structural binding inference,
including authorization, credentials, cookies, passwords, private keys,
secrets, tokens and API keys. This is defense in depth, not a data-loss
prevention guarantee: custom field names may not look secret.

Do not place credentials in generated code. The model-visible code and logs can
be retained by the calling agent.

## Learner state

State files contain compact counts, learned bindings and redacted pre-pattern
evidence, not full traces or raw tool outputs. Before promotion, candidate
bindings and constants are represented by truncated SHA-256 fingerprints;
one-shot template fragments and values remain in memory only. A stable
non-secret input constant can be persisted after promotion; commands, paths,
queries, text and similar provenance-sensitive strings require the configured
higher support threshold. Fingerprints are data minimization, not encryption:
low-entropy values may be guessable, and paths/tool names reveal workflow
structure. Set `learning.persistBindingEvidence` to `false` to omit pre-pattern
evidence while retaining promoted rules.

Redacted pools also have a separate serialized byte budget (4 MiB by default).
When the configured state envelope is smaller, the runtime caps evidence at
half of `state.maxStateBytes` so PPM rows, promoted patterns and JSON overhead
retain space.

- Store state in an access-controlled application-data location.
- Set `state.maxStateBytes` to a reasonable bound.
- Use `"state": false` for sensitive or ephemeral deployments.
- Do not commit `.codemode/` state files.

Writes use a unique sibling temporary file and destination replacement. On
platforms that honor POSIX modes, newly written files request mode `0600`.

## Upstream servers

An upstream MCP server runs with its own process and network privileges. Treat
its package, command, URL and updates as trusted deployment configuration.
Prefer pinned package versions and HTTPS. The gateway does not inspect or
sandbox an upstream stdio server process.

Tool descriptions and returned text may contain prompt-injection content. Code
Mode reduces round trips but does not solve semantic prompt injection. Keep the
agent's normal data/tool trust policy in place.

## Operational checklist

- Pin `codemode`, upstream MCP servers and their dependencies.
- Run `npm audit --omit=dev` and the repository checks after upgrades.
- Start with low call/concurrency/time budgets.
- Expose direct tools only when ordinary ReAct access is intended.
- Apply registry policies to high-impact tools in embedding hosts.
- Monitor stderr for persistence, transport and provider failures.
- Review learned state handling and retention.

## Reporting a vulnerability

Please use GitHub's private security-advisory reporting for this repository when
available. Do not include live credentials, private tool output or an active
exploit against a third-party MCP service in a public issue.

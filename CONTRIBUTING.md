# Contributing

Contributions are welcome. Keep changes focused and preserve the gateway's
three main invariants:

1. authoritative upstream behavior is never changed by learning or hints;
2. generated code reaches only explicitly installed tool bridges; and
3. learned fusion paths require replayable structured data flow.

## Setup

```sh
npm ci --ignore-scripts
npm run check
```

The check command performs strict TypeScript validation, all unit/integration
tests, a declaration build and a real stdio subprocess smoke test.

## Code expectations

- Keep `strict`, `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` clean.
- Do not use `any`; narrow external values from `unknown`.
- Validate both sides of a tool boundary where schemas are available.
- Add a regression test for every behavior or bug fix.
- Do not make observation, hinting or persistence failures alter an otherwise
  successful authoritative tool result.
- Keep raw tool values out of durable learning state.
- Preserve source attribution in `THIRD_PARTY_NOTICES.md` for adapted code.

Tests that create processes or temporary files must close them in `finally` or
test cleanup hooks and must work on Windows and Linux.

## Pull requests

Explain the user-visible behavior, security impact and verification performed.
Small commits that separate learning, execution, transport and documentation
changes are easier to review. Do not commit credentials, generated `dist/`,
`node_modules/` or learner state.

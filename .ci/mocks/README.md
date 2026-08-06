# Private dependency mocks

The extension consumes `casc-ts` and `war3-model` through local `file:../...`
dependencies. Their real repositories are private development sources, so the
GitHub Actions build copies these minimal packages into the expected sibling
paths before installing dependencies.

These mocks provide the API, shader markers, and sequence-less model behavior
needed by the extension's static/unit checks. They do not replace local
integration tests against the real packages or game data.

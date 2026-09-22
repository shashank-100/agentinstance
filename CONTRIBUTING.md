# Contributing

## Tests

```sh
npm test
```

Read the output, not just the exit code — `vitest` can exit 0 while running
zero tests. Confirm the test count is what you expect.

## Git

Work goes **direct to `main`**: merge locally, push. No PR, no branch
protection, no CI. `npm test` is the only gate.

Commit messages are one line, no body, no trailers.

## Deploying

`wrangler deploy` builds a container image and pushes it. **Docker must be
running** — every agent runs in a container, and the image push needs a
working Docker daemon to build against.

See `AGENTS.md` for the full picture (architecture, testing philosophy,
harness pins, secrets) before making non-trivial changes.

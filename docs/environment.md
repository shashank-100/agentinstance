# Environment snapshot

A quick reference for the runtime and source footprint of this repo. Both
numbers are easy to re-derive, so treat this as a snapshot rather than a
source of truth — regenerate it with the commands below.

## Node

```
$ node --version
v22.23.2
```

`package.json` has no `engines` field and there is no `.nvmrc`, so nothing in
the repo pins a Node version. Node 22 is what the toolchain is currently
exercised against.

## TypeScript sources in `src/`

```
$ find src -name '*.ts' -type f | wc -l
20
```

20 `.ts` files, no `.tsx`:

```
src/agent-instance.ts      src/harnesses/index.ts
src/auth.ts                src/harnesses/vm-tools.ts
src/capabilities/index.ts  src/index.ts
src/catalog.ts             src/keys.ts
src/channels/index.ts      src/models/index.ts
src/channels/telegram.ts   src/parts.ts
src/channels/web.ts        src/registry-do.ts
src/fleet-do.ts            src/sandbox/index.ts
src/github-app.ts          src/scope.ts
src/gmail.ts               src/types.ts
```

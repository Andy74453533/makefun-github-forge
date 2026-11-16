# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Andy74453533/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Andy74453533/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, with its own
in-memory store and no outside services: clone and push over git smart
HTTP (protocol v2 plus the v0 fallback), repositories, issues, pull
requests and file contents over REST v3, queries and mutations over
GraphQL, and tools over MCP. All four surfaces share one store, so a
commit pushed over git is immediately visible over REST, GraphQL and MCP,
and a merge made anywhere advances the same refs.

Deterministic by design: timestamps come from a tick clock seeded by the
trial time, ids and request ids come from counters, and packfiles are
built in a fixed order, so replaying the same requests produces the same
bytes.

## Run it

```sh
node main.ts
```

Requires Node 22. No dependencies, no build step: `main.ts` is erasable
TypeScript run directly by Node's type stripping. The server binds an
ephemeral loopback port; when `MAKEFUN_ENV_URL` is set it registers the
port with the trial environment and exits when the trial reports done.
`MAKEFUN_SHOP_TOKEN` sets the bearer token every surface except
`/healthz` requires.

## Layout

- `main.ts` — trial lifecycle: bind, register, poll for done.
- `src/app.ts` — the HTTP shell: routing, auth, framing.
- `src/store.ts` — the forge: objects, refs, issues, pulls, merges, fetch plans.
- `src/gitobjects.ts` — git objects, packfile read/write, delta resolution.
- `src/gitserver.ts` — smart HTTP: advertisements, upload-pack, receive-pack.
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — a small GraphQL lexer, parser and executor.
- `src/mcp.ts` — MCP over Streamable HTTP (JSON-RPC 2.0).

---

<sub>Entered on [make.fun](https://make.fun/?ref=v0ehxw86&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

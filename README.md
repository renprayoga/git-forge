# git-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/renprayoga/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/renprayoga/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge, written from scratch for the make.fun bounty
**"Build a GitHub-compatible git forge"**
([github-core-clone-01](https://make.fun/bounty/github-core-clone-01)).

One process, one port, Node stdlib only — no dependencies, no git binary,
no external services. It serves git smart HTTP (protocol v0 and v2),
GitHub REST API v3, GraphQL v4, and MCP over Streamable HTTP, all against
the same in-memory store.

## Run it

```sh
node main.ts
```

Node 22.18+ (type stripping on by default). In the trial the harness sets
`MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`: the entry binds an ephemeral
port, registers it, polls `/done`, and exits 0. Without `MAKEFUN_ENV_URL`
(local development) it serves on `$PORT` (default 3000) and stays up; any
non-empty bearer token is accepted unless `MAKEFUN_SHOP_TOKEN` is set.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entry ↔ env lifecycle (register / wait-for-done), plus the standalone fallback |
| `src/app.ts` | HTTP server: routing, bearer auth, request ids, JSON 404s |
| `src/store.ts` | In-memory store: SHA-1 objects, packs, repos, issues, PRs; lazy viewer binding |
| `src/git.ts` | Git smart HTTP: pkt-lines, v0/v2 upload-pack, receive-pack, shallow fetch |
| `src/rest.ts` | GitHub REST v3: repos, branches, commits, contents, labels, issues, comments, pulls, merges |
| `src/graphql.ts` | GraphQL v4: a small executor for the documents `gh` and `github-mcp-server` send |
| `src/mcp.ts` | MCP over Streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `src/http.ts` | Shared request/response plumbing |
| `.makefun/owner.json` | Claim file: `{"wallet": "<Rin's Solana address>"}` (public address only) |
| `LICENSE` | MIT |

## Design notes

- **Viewer identity is learned lazily.** The trial token is opaque and the
  scenario viewer login is seed-derived, so the entry cannot know it in
  advance. The first owner-bearing request (REST path, git URL, GraphQL
  `owner` arg, MCP `owner` arg) binds the viewer; repos created before
  binding are re-keyed to it. Any other owner reads as 404, never 403.
- **Pure-TypeScript git.** Objects are SHA-1 hashed in-process; packfiles
  are written and read by hand (v2, OFS/REF delta resolution). No git
  binary, no wrapping of any existing forge.
- **Fast paths.** Pack and issue responses are cached per repo version;
  shallow fetches walk only the generations the depth needs; issue JSON is
  pre-serialised per issue.
- **Protocol details that matter:** the v2 fetch answers an
  `acknowledgments` section only when the client sent haves (real git
  rejects it otherwise); the shallow boundary names the deepest included
  commit; the receive-pack report-status stream ends with its own flush
  inside sideband band 1 (real git dies on EOF without it); ls-refs
  reports HEAD when a prefix matches it and excludes it otherwise.

## Measured results (local, kit `sdk/run.ts`)

- Conformance: **120 / 120 checks** (git 30, repos 15, issues 15, pulls 20,
  protocol 5, graphql 20, mcp 15)
- Performance (`--perf`): **177 / 200 points** — push 41–42, clone 43–46,
  read 50, write 39–46 (rounds vary a few points run to run on a shared VM)
- Score formula in the kit: `round(600·passed/120) + round(200·mcp/15) +
  perf` → **600 + 200 + 177 = 977** on the practice instance

The final grading runs 3 unseen instances and takes the mean; these numbers
are for the practice instance only.

## What is not in the entry

- No persistence: the store is in-memory, which is what the trial expects
  (a fresh, empty forge per instance).
- No webhooks, milestones, reviews, or branch protection beyond the
  scored surface — the kit scores the surface listed above, and that is
  what is implemented.
- `kit/` (the downloaded competition kit) and `BUILD_LOG.md` are working
  files in the workspace, not part of the entry commit.

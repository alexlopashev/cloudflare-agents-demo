# Regression Surgeon

Regression Surgeon is a Cloudflare-native agent that investigates measured UX latency regressions, traces them through a supervised full-stack application, correlates the first bad release with its GitHub commit and pull request, and proposes a minimal evidence-backed fix as a guarded draft PR.

The project is a take-home exercise for building and deploying a genuine multi-step AI agent on Cloudflare Workers. The agent and the application it supervises live in this monorepo.

## Intended demonstration

1. Open Deployboard and refresh its service-health grid.
2. Observe a measurable latency regression.
3. Ask Regression Surgeon to investigate it.
4. Watch the Project Think agent compare releases, inspect traces, and read repository evidence.
5. Review the identified commit and source PR.
6. Approve a bounded draft-PR proposal.

## Architecture

- Cloudflare Workers and the Cloudflare Vite plugin
- Project Think with Workers AI
- SQLite-backed Durable Object state for conversations
- D1 for measured UX events, traces, spans, and releases
- An auxiliary health-service Worker reached through a service binding
- A constrained, read-only GitHub REST adapter for immutable repository evidence
- An approval-gated GitHub adapter for bounded, idempotent draft PR creation
- React, TypeScript, pnpm, and a mise-managed toolchain

The initial product supports one controlled repository, one supervised application, one latency-regression scenario, and one guarded remediation path. It is intentionally not a general-purpose coding agent.

## Supported development environments

- macOS ARM64 and x64
- Linux ARM64 and x64
- sh, Bash, Zsh, Fish, and Nu

Bootstrap is repository-local and affects only the active shell. It never edits a shell profile, installs tools into a system path, or inherits tools from a user's global mise configuration.
Repository automation uses `scripts/*.ts`, executed directly through Node 24.18's stable type
stripping with `erasableSyntaxOnly`; `tsc --noEmit` remains the separate strict type-checking gate.

The reproducible foundation, Cloudflare application skeleton, supervised Deployboard, immutable
repository connector, measured telemetry pipeline, and evidence-driven investigation are
implemented, including guarded remediation preview and write boundaries.

### Bootstrap

From the repository root:

```sh
# sh
. ./scripts/bootstrap

# Bash or Zsh
source ./scripts/bootstrap
```

```fish
source ./scripts/bootstrap.fish
```

```nu
source ./scripts/bootstrap.nu
```

Each filesystem-changing bootstrap stage uses a single-keystroke `Y/n` confirmation. The approved
path installs the locked dependencies, applies repository-local D1 migrations, loads the measured
good/bad fixtures, builds the application, and runs the complete credential-free verification suite.
Colima is never started by bootstrap.

### Core tasks

```text
mise run doctor
mise run build
mise run check
mise run db:migrate
mise run scenario:reset
mise run scenario:reseed
mise run dev
mise run dev:live
mise run e2e
mise run auth:cloudflare
mise run deploy
mise run deploy:smoke
mise run deploy:refresh
mise run deploy:reset
mise run container:check
mise run container:up
mise run container:down
mise run teardown
```

`mise run dev` first applies pending migrations to the repository-local D1 database, then starts the
complete Cloudflare stack in deterministic fake-model mode, with no credentials or remote AI usage.
It serves Deployboard at `/app`, the durable Project Think session at `/investigator`, and the
platform APIs from one URL. The current release intentionally serializes the three 120 ms service
checks to create the controlled regression. `mise run scenario:reseed` regenerates 20 measured
concurrent and 20 measured sequential interactions in local D1; `mise run scenario:reset` removes
only those two releases. `mise run dev:live` builds the app and starts the same Worker with the
explicit Workers AI configuration; Cloudflare authentication and remote usage apply. `mise run e2e`
verifies both public routes, runtime metadata, the auxiliary service binding, trace persistence,
correlated browser telemetry, statistically distinguishable scenario evidence, and a credential-free
five-step Project Think investigation that cites the measured trace, immutable commit, and source PR.
It also validates an evidence-rich draft-PR preview against base/blob freshness, path, byte, line, and
changed-line limits while proving that local mode performs no GitHub writes.

### Public Cloudflare deployment

The current no-login demo is
[regression-surgeon-platform.alexlopashev.workers.dev](https://regression-surgeon-platform.alexlopashev.workers.dev/app).
Authenticate once with `mise run auth:cloudflare`, then run `mise run deploy`. The task reuses or
creates only the named D1 database, builds both Workers and the web app, applies remote migrations,
deploys a concurrent baseline and measures 20 interactions, deploys the sequential regression and
measures 20 interactions, then deploys the public GLM 4.7 Flash investigator with those exact
Cloudflare version IDs and trace timestamps. It finishes with a keyed smoke that verifies the two
public routes, runtime metadata, the five-step Workers AI evidence chain, a validated remediation
preview, and the default-off GitHub write posture.

`mise run deploy:refresh` redeploys only the investigator while preserving the measured evidence.
`mise run deploy:smoke` repeats the deployed verification. `mise run deploy:reset` deletes only the
two release IDs recorded by the last deployment from remote D1; run `mise run deploy` afterward to
recreate evidence. The deployment state and smoke key live under ignored `.local/deploy` with
owner-only permissions. The public app requires no login and creates a durable session identifier in
browser-local storage.

No GitHub token is copied from `gh` or uploaded by the deployment task. In the credential-free public
posture, D1 resolves the real Worker version to an immutable commit SHA and the repository boundary
serves the committed, SHA-gated fixture for commit/PR/source evidence. A supplied scoped token selects
the live read connector; external writes additionally require `GITHUB_WRITE_ENABLED=true`, explicit
Project Think approval, and all repository/path/SHA/blob/size gates. The published demo deliberately
keeps that flag false, so approval yields a preview and cannot create or merge a pull request.

### Optional Colima parity

The native path above is canonical. For a clean Linux-container parity check, run:

```text
mise run container:up
```

This starts the dedicated `polylane-take-home` Colima profile without changing the active Docker
context, assigns the profile 4 GiB of memory, mounts the exact repository root, builds one Linux
service, waits for its health check, and exposes the same application at `http://127.0.0.1:5173`.
The container runs the canonical `mise run dev` task. Source code is bind mounted, while
`node_modules`, `.local`, and `.wrangler` use Linux-owned named volumes so host-native `workerd`
binaries can never leak into the container. The explicit repository mount means clones and worktrees
outside the home directory behave the same way.

`mise run container:down` removes the Compose containers and network, stops Colima only when this
project started it, and preserves the named volumes for a fast restart. `mise run teardown` is the
full reset: it also removes project Compose volumes and deletes a Colima profile only when a
repository ownership marker proves this project created it. Both operations are repeatable, and a
failed start retains the marker required for safe recovery. A pre-existing profile is never deleted.

## Engineering method

This repository follows strict test-driven development. Every behavior change begins with a test that fails for the intended reason, proceeds through the smallest passing implementation, and ends with refactoring plus repository quality gates.

Read [AGENTS.md](AGENTS.md) before changing code. It defines the required TDD workflow, behavioral invariants, linting and formatting standards, security constraints, and definition of done.

## Project documentation

- [Implementation plan](IMPLEMENTATION_PLAN.md)
- [GitHub wiki](https://github.com/alexlopashev/cloudflare-agents-demo/wiki)
- [v1 milestone](https://github.com/alexlopashev/cloudflare-agents-demo/milestone/1)
- [Delivery tracking issue](https://github.com/alexlopashev/cloudflare-agents-demo/issues/1)
- [Open delivery issues](https://github.com/alexlopashev/cloudflare-agents-demo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3A%22v1%20%E2%80%94%20Regression%20Surgeon%22)
- [Project alignment skill](.agents/skills/align-project-system/SKILL.md)

After every meaningful change, contributors must reassess and align the implementation plan, GitHub milestone and dependency graph, wiki and README, `AGENTS.md`, and repository-local skills.

## Current status

Phases 1 through 8 are implemented and verified locally and on Cloudflare. The real known-good release at `cf25e52`
loads three service checks concurrently; the current scenario release intentionally serializes them
to reduce simultaneous downstream pressure. A deterministic reseed measured local p75 latency near
127 ms versus 380 ms and stored sequential service spans on the degraded critical path. Reset and
reseed are idempotent and preserve unrelated telemetry. Project Think now performs five bounded
evidence steps, reports measured latency and trace evidence, resolves commit `d591869…` and PR #19,
and survives browser reconnection without duplicating messages or tool effects. The guarded
`create_draft_pr` action now requires explicit Project Think approval, is disabled for external writes
by default, produces a credential-free local preview, and exposes no merge capability. Its live REST
adapter restricts repository, path, SHA/blob freshness, request/response size, changed lines, draft
state, and incident idempotency; deterministic branch names make partial writes recoverable.
Native bootstrap now reaches the complete local E2E, and the optional Colima lane reproduces the same
dev task through one isolated Linux service with ownership-safe recovery and teardown. The public
deployment measured p75 latency of 245 ms for Cloudflare version `0c2432d5…` and 538 ms for version
`01e7b428…`; the deployed Workers AI smoke traced that regression to commit `d591869…` and PR #19,
read the pinned source, produced a structured report, and validated a no-write remediation preview.
[Issue #12](https://github.com/alexlopashev/cloudflare-agents-demo/issues/12) is next: final clean-room
release-readiness verification. The milestone and native blocked-by issue graph remain the executable
delivery plan.

## License

MIT

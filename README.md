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
- A planned approval-gated GitHub adapter for bounded draft PR creation
- React, TypeScript, pnpm, and a mise-managed toolchain

The initial product supports one controlled repository, one supervised application, one latency-regression scenario, and one guarded remediation path. It is intentionally not a general-purpose coding agent.

## Supported development environments

- macOS ARM64 and x64
- Linux ARM64 and x64
- sh, Bash, Zsh, Fish, and Nu

Bootstrap is repository-local and affects only the active shell. It never edits a shell profile, installs tools into a system path, or inherits tools from a user's global mise configuration.

The reproducible foundation, Cloudflare application skeleton, supervised Deployboard, immutable
repository connector, and measured telemetry pipeline are implemented.

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
correlated browser telemetry, and statistically distinguishable scenario evidence.

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

Phases 1 through 4 are implemented and verified locally. The real known-good release at `cf25e52`
loads three service checks concurrently; the current scenario release intentionally serializes them
to reduce simultaneous downstream pressure. A deterministic reseed measured local p75 latency near
128 ms versus 381 ms and stored sequential service spans on the degraded critical path. Reset and
reseed are idempotent and preserve unrelated telemetry. The independently sequenced read-only
repository connector is also complete. Issue #8 is next: it wires telemetry and immutable repository
evidence into the Project Think investigation loop. The milestone and native blocked-by issue graph
remain the executable delivery plan.

## License

MIT

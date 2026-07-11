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
- A constrained GitHub REST adapter for repository inspection and draft PR creation
- React, TypeScript, pnpm, and a mise-managed toolchain

The initial product supports one controlled repository, one supervised application, one latency-regression scenario, and one guarded remediation path. It is intentionally not a general-purpose coding agent.

## Supported development environments

- macOS ARM64 and x64
- Linux ARM64 and x64
- sh, Bash, Zsh, Fish, and Nu

Bootstrap is repository-local and affects only the active shell. It never edits a shell profile or installs tools into a system path.

The implementation has not been scaffolded yet. The commands below are the committed interface that the foundation issue will implement.

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
mise run dev
mise run e2e
mise run deploy
```

`mise run dev` will provide a credential-free deterministic model for local development. `mise run dev:live` will use the remote Workers AI binding.

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

Planning is complete and implementation is ready to begin. The GitHub milestone and blocked-by issue graph are the executable delivery plan.

## License

MIT

# Regression Surgeon

Regression Surgeon is a Cloudflare-native agent that investigates a measured UX latency regression,
traces it through a supervised full-stack application, correlates the degraded release with immutable
GitHub evidence, and prepares a minimal evidence-backed remediation preview. A real draft PR is an
optional, approval-gated operator extension.

The project is a take-home exercise for building and deploying a genuine multi-step AI agent on
Cloudflare Workers. The agent and the application it supervises live in this repository.

## Intended demonstration

1. Open Regression Investigator from Deployboard's floating launcher.
2. Start the configured seeded-latency investigation.
3. Watch five bounded evidence phases connect releases, traces, immutable Git history, and source.
4. Review the structured evidence, inference, confidence, and unknowns.
5. Inspect the exact one-file remediation diff and its evidence references.
6. Verify that the public runtime is write-disabled and the result is a validated preview.

Deployboard's fixed-size metric generator is an optional demonstration of telemetry ingestion. It
does not select or modify the seeded incident investigated by the agent.

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

Bootstrap is repository-local and shell-neutral. It never edits a shell profile, installs tools into
a system path, or inherits tools from a user's global mise configuration. Activation opens a
project-scoped child shell, so leaving that shell removes its environment changes.
Repository automation uses `scripts/*.ts`, executed directly through Node 24.18's stable type
stripping with `erasableSyntaxOnly`; `tsc --noEmit` remains the separate strict type-checking gate.

The reproducible foundation, Cloudflare application skeleton, supervised Deployboard, immutable
repository connector, measured telemetry pipeline, and evidence-driven investigation are
implemented, including guarded remediation preview and write boundaries.

Deployboard can generate fixed batches of 5, 10, or 20 real current-release interactions as an
optional ingestion demonstration. Samples run sequentially and count only after UX telemetry is
stored; refresh and generation cannot overlap. They do not replace or select the configured
baseline/degraded evidence pair.
The investigator remains mounted as a collapsible support-style dialog with a floating launcher,
attention and availability badges, safe GitHub-flavored Markdown, and literal user requests. The
desktop panel is bounded, while the mobile panel fills the viewport with a full-width 44px send
action. `/investigator` opens the same Deployboard experience with the widget expanded.

### Bootstrap

From the repository root:

```text
./scripts/bootstrap
./scripts/activate
```

The same POSIX entrypoints work from sh, Bash, Zsh, Fish, and Nu. `activate` opens the shell named by
`SHELL` with the repository-local mise binary and shims available. To run one command without
opening a child shell, pass it directly, for example `./scripts/activate mise run check`.

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
mise run github:writes:secret
mise run github:writes:secret:delete
mise run deploy
mise run deploy:smoke
mise run deploy:refresh
mise run deploy:writes:enable
mise run deploy:writes:disable
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
five-operation Project Think investigation that cites the measured trace, immutable commit, and source PR.
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
public routes, runtime metadata, the five-operation Workers AI evidence chain, a validated remediation
preview, and the expected GitHub write posture.

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

#### Optional live draft PR

To demonstrate a real draft PR, create a short-lived fine-grained GitHub token restricted to this
repository with **Contents: read and write** and **Pull requests: read and write**; leave Actions,
Administration, Secrets, and every other write permission disabled. Run
`mise run github:writes:secret` and enter the token only at Wrangler's terminal prompt. Then run
`mise run deploy:writes:enable`. The task fails closed unless Cloudflare reports the exact secret,
preserves the measured evidence pair, deploys the explicit write posture, and runs a preview-only
smoke that cannot create a PR. If deployment or smoke fails after mutation begins, the task
automatically redeploys the preserved evidence with writes disabled and verifies that posture
without calling Workers AI; if rollback cannot be verified, both errors are reported. A real PR can
be created only when the browser agent requests the
high-risk action and a human clicks Approve. If `main` has advanced, the write service proceeds only
when the allowlisted source blob is unchanged from the evidenced regression commit, then parents the
new one-file commit on current `main`; otherwise it fails stale. Run
`mise run deploy:writes:disable` immediately after the demonstration; ordinary `deploy` and
`deploy:refresh` also return to the default-off posture.
After disabling writes, run `mise run github:writes:secret:delete` to revoke the Worker credential.
The keyed smoke may retry the endpoint's pre-execution 404 briefly while a newly rotated smoke key
propagates across Cloudflare. It returns every other status immediately, so a Workers AI turn or
other endpoint work is never duplicated.

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
- [Historical v1/v1.1 release evidence](RELEASE_READINESS.md)
- [GitHub wiki](https://github.com/alexlopashev/cloudflare-agents-demo/wiki)
- [v1 milestone](https://github.com/alexlopashev/cloudflare-agents-demo/milestone/1)
- [v1.1 interactive-demo milestone](https://github.com/alexlopashev/cloudflare-agents-demo/milestone/2)
- [Active v1.2 review-readiness milestone](https://github.com/alexlopashev/cloudflare-agents-demo/milestone/3)
- [Next-session handoff and delivery tracker](https://github.com/alexlopashev/cloudflare-agents-demo/issues/48)
- [Interactive demo UX issue](https://github.com/alexlopashev/cloudflare-agents-demo/issues/25)
- [Delivery tracking issue](https://github.com/alexlopashev/cloudflare-agents-demo/issues/1)
- [Open v1.2 delivery issues](https://github.com/alexlopashev/cloudflare-agents-demo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3A%22v1.2%20%E2%80%94%20Review-ready%20evidence%20core%22)
- [Project alignment skill](.agents/skills/align-project-system/SKILL.md)

After every meaningful change, contributors must reassess and align the implementation plan, GitHub milestone and dependency graph, wiki and README, `AGENTS.md`, and repository-local skills.

## Current status

The existing vertical slice works locally and on Cloudflare: measured baseline/degraded evidence,
bounded repository inspection, a multi-step Project Think investigation, durable conversation state,
and a guarded zero-write remediation preview. GitHub writes remain disabled by default.

Each investigation now starts from one validated incident reference containing its incident ID,
immutable baseline/degraded release pair, and bounded degraded trace window. That reference persists
with the investigation, scopes evidence requests and remediation preparation, and appears in runtime
verification. Starting again creates fresh investigation state, while optional current-release
metric ingestion cannot replace the configured incident.

The active [v1.2 milestone](https://github.com/alexlopashev/cloudflare-agents-demo/milestone/3)
hardens that slice rather than expanding it. Work now makes evidence incident-scoped, binds
remediation mechanically to the same receipt, repairs telemetry semantics, strengthens smoke and
developer commands, removes test scaffolding from live composition, and makes the first reviewer
interaction truthful. Until [issue #48](https://github.com/alexlopashev/cloudflare-agents-demo/issues/48)
closes, treat the public deployment as a working implementation under review hardening.

Mutable deployment snapshots and incident history live in issue comments and the dated
[release record](RELEASE_READINESS.md). A real GitHub draft PR remains the optional operator proof in
[issue #30](https://github.com/alexlopashev/cloudflare-agents-demo/issues/30), not a prerequisite for
the credential-free reviewer journey.

## License

MIT

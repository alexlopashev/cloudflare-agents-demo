# v1 Release Readiness

Verified on 2026-07-12 from a clean macOS ARM64 worktree at merged commit `e470dd4`.

## Clean-room evidence

- Sourced `scripts/bootstrap` in Zsh with no repository-local mise or dependencies present.
- Installed and activated the pinned repository-local toolchain without editing a shell profile.
- Applied both local D1 migrations.
- Generated 20 concurrent and 20 sequential interactions; measured p75 132 ms versus 383 ms.
- Passed `mise run check`: 26 foundation checks plus one host-only Fish skip, 121 unit and
  integration tests, and 15 Worker tests.
- Passed `mise run build` for the platform Worker, health-service Worker, and React client.
- Passed `mise run e2e`: both routes, service binding, telemetry persistence, five evidence tools,
  structured report, guarded preview, and zero GitHub writes.

Fish execution and the other three supported OS/architecture combinations are covered by the four
required GitHub Actions lanes. PR #23 passed macOS ARM64/x64 and Linux ARM64/x64 before merge.

## Public reviewer evidence

- Public app: <https://regression-surgeon-platform.alexlopashev.workers.dev/app>
- Investigator: <https://regression-surgeon-platform.alexlopashev.workers.dev/investigator>
- Baseline Worker version: `0c2432d5-d661-4f1b-aa42-4c8907580774`, measured p75 245 ms.
- Degraded Worker version: `01e7b428-ac68-4875-b178-b1fcf7874a7c`, measured p75 538 ms.
- The deployed smoke verifies the exact runtime metadata, both public routes, real Workers AI turn,
  telemetry comparison, representative trace, commit `d591869…`, PR #19, pinned source, validated
  remediation preview, and `GITHUB_WRITE_ENABLED=false`.

Run `mise run deploy:smoke` from the worktree that last deployed the stack. Its ignored
`.local/deploy/state.json` contains the exact remote version IDs and an owner-only smoke credential.

## Known limitations and deferred work

- v1 supports one public repository, one supervised application, one metric, and one controlled
  regression. Repository onboarding and arbitrary incidents are deferred.
- The public demo has no user authentication or general rate limiting. Its diagnostic smoke route is
  protected by an unguessable Worker secret and returns 404 without it.
- Without a scoped GitHub token, D1 must first resolve the measured Worker version to the known
  regression SHA; only then does the repository boundary use the committed commit/PR/source fixture.
- The published runtime keeps GitHub writes disabled. A live draft PR additionally needs a narrowly
  scoped token, explicit write enablement, Project Think approval, and all server-side safety gates.
- Live-model prose is nondeterministic. Verification asserts tool selection, evidence references,
  preview status, and terminal output rather than exact wording.
- The agent cannot merge, deploy a proposed change, or roll back a release.
- Deployment incurs Cloudflare D1 and Workers AI usage and creates intermediate Worker versions while
  atomically replacing the keyed smoke secret.

## Alignment evidence

- `README.md`, `IMPLEMENTATION_PLAN.md`, `AGENTS.md`, and this release record describe the same v1.
- The GitHub wiki mirrors product, architecture, operations, decisions, development, and roadmap.
- Issues #2–#11 are closed; #12 is blocked by #11 and blocks the v1 tracking issue #1.
- The repository-local alignment skill validates successfully.

# v1 and v1.1 Release Readiness

The v1 clean-room release was verified on 2026-07-12 from a macOS ARM64 worktree at merged commit
`e470dd4`. The v1.1 public interface was deployed later that day from main commit `41dee5d`.

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
- Baseline Worker version: `3cdd02af-a0e5-4258-b795-ab277021300b`, measured p75 328 ms.
- Degraded Worker version: `9f6f4949-63fb-4d4b-8c97-e0e134deb8b9`, measured p75 493 ms.
- Investigator Worker version: `eac2cc77-e50c-4c8e-b39d-52a439304b13`, attributed to `41dee5d`.
- The deployed smoke verifies the exact runtime metadata, both public routes, real Workers AI turn,
  telemetry comparison, representative trace, commit `d591869…`, PR #19, pinned source, validated
  remediation preview, and `GITHUB_WRITE_ENABLED=false`.
- Browser verification at 1280 px confirmed the bounded metric generator and badged floating
  launcher. At 390×844, the investigator filled the viewport and its send button measured 350×44.

The issue #27 follow-up is deployed from main commit `008969a` as investigator version
`e69e1a38-5abd-4cda-94ba-96ef981a5656`. Browser verification confirms that the redundant header
pills are absent and the persisted failed session preserves its message while enabling an explicit
retry. This version is not yet a passing deployed gate: Workers AI returns error 4006 because the
account exhausted its daily free allocation of 10,000 neurons, so the keyed smoke cannot produce the
trace evidence required for remediation preview. Issue #27 and milestone 2 remain open until a real
browser turn and keyed smoke pass after allocation recovery.

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

- `README.md`, `IMPLEMENTATION_PLAN.md`, `AGENTS.md`, and this release record describe the same v1
  and focused v1.1 delivery.
- The GitHub wiki mirrors product, architecture, operations, decisions, development, and roadmap.
- The v1 milestone is closed. The v1.1 milestone is open for issue #27, which has no native
  dependency relations and is blocked only by the external Workers AI allocation reset or upgrade.
- The repository-local alignment skill validates successfully.

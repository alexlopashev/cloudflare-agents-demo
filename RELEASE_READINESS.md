# Historical v1 and v1.1 Release Evidence

The v1 clean-room release was verified on 2026-07-12 from a macOS ARM64 worktree at merged commit
`e470dd4`. The v1.1 public interface was deployed later that day from main commit `41dee5d`.

This is a dated evidence record, not the current completion claim. The active
[v1.2 review-readiness milestone](https://github.com/alexlopashev/cloudflare-agents-demo/milestone/3)
tracks evidence provenance, telemetry integrity, exact verification, and reviewer-flow hardening.

## Clean-room evidence

- Sourced `scripts/bootstrap` in Zsh with no repository-local mise or dependencies present.
- Installed and activated the pinned repository-local toolchain without editing a shell profile.
- Applied both local D1 migrations.
- Generated 20 concurrent and 20 sequential interactions; measured p75 132 ms versus 383 ms.
- Passed `mise run check`: 26 foundation checks plus one host-only Fish skip, 121 unit and
  integration tests, and 15 Worker tests.
- Passed `mise run build` for the platform Worker, health-service Worker, and React client.
- Passed `mise run e2e`: both routes, service binding, telemetry persistence, five evidence operations,
  structured report, guarded preview, and zero GitHub writes.

Fish execution and the other three supported OS/architecture combinations are covered by the four
required GitHub Actions lanes. PR #23 passed macOS ARM64/x64 and Linux ARM64/x64 before merge.

## Public reviewer evidence

- Public app: <https://regression-surgeon-platform.alexlopashev.workers.dev/app>
- Investigator: <https://regression-surgeon-platform.alexlopashev.workers.dev/investigator>
- Baseline Worker version: `3cdd02af-a0e5-4258-b795-ab277021300b`, measured p75 328 ms.
- Degraded Worker version: `9f6f4949-63fb-4d4b-8c97-e0e134deb8b9`, measured p75 493 ms.
- Investigator Worker version: `eac2cc77-e50c-4c8e-b39d-52a439304b13`, attributed to `41dee5d`.
- The historical deployed smoke observed runtime metadata, both public routes, a real Workers AI
  turn, telemetry comparison, representative trace, commit `d591869…`, PR #19, pinned source,
  validated remediation preview, and `GITHUB_WRITE_ENABLED=false`.
- Browser verification at 1280 px confirmed the bounded metric generator and badged floating
  launcher. At 390×844, the investigator filled the viewport and its send button measured 350×44.

The issue #27 implementation now includes failed-turn retry, the simplified header, bounded evidence
forcing, and Workers-compatible GitHub fetch invocation. Later live runs recovered Workers AI access
and reached GitHub inspection, but the supplied fine-grained token returned HTTP 403. No source read,
proposal, branch, commit, or PR occurred; rollback and secret deletion left the public runtime
write-disabled. The v1.2 exact-verification work now validates one shared structured receipt locally
and in deployed smoke; #27 owns the fresh credential-free public smoke and browser turn. A real
GitHub write remains optional in issue #30.

Run `mise run deploy:smoke` from the worktree that last deployed the stack. Its ignored
`.local/deploy/state.json` contains the exact remote version IDs and an owner-only smoke credential.

## Known limitations and deferred work

- v1 supports one public repository, one supervised application, one metric, and one controlled
  regression. Repository onboarding and arbitrary incidents are deferred.
- The public demo has no user authentication or general rate limiting. Its diagnostic smoke route is
  protected by an unguessable Worker secret and returns 404 without it.
- Without a scoped GitHub token, D1 first resolves the measured Worker version to its immutable SHA;
  the bounded production GitHub adapter then performs unauthenticated commit, PR, source, base, and
  blob reads. Deterministic fixtures remain local verification adapters only.
- The published runtime keeps GitHub writes disabled. A live draft PR additionally needs a narrowly
  scoped token, explicit write enablement, Project Think approval, and all server-side safety gates.
- Live-model prose is nondeterministic. Verification asserts exact structured phases,
  cross-references, required report sections, remediation fingerprint, preview status, and zero
  writes rather than exact wording.
- The agent cannot merge, deploy a proposed change, or roll back a release.
- Deployment incurs Cloudflare D1 and Workers AI usage and creates intermediate Worker versions while
  atomically replacing the keyed smoke secret.

## Alignment evidence

- `README.md`, `IMPLEMENTATION_PLAN.md`, and the wiki identify this document as historical evidence
  and point to v1.2 for the current completion contract.
- The v1 milestone is closed. The v1.1 milestone remains open only for carried public verification
  in issue #27; issue #30 is an unmilestoned optional operator extension.
- The v1.2 milestone and native dependency graph are the executable review-readiness roadmap.
- `AGENTS.md` and the alignment skill remain the authoritative delivery workflow.
- The repository-local alignment skill validates successfully.

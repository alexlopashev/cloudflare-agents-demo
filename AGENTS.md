# Repository Working Agreement

## Scope

These instructions apply to the entire repository. More specific `AGENTS.md` files may add constraints for a subtree but may not weaken the test-driven development, safety, linting, formatting, or verification requirements defined here.

## Non-negotiable test-driven development workflow

All production behavior is developed test-first.

For every feature, behavior change, or bug fix:

1. Identify the observable behavior and meaningful invariants.
2. Add or change the smallest test that expresses the desired behavior.
3. Run the targeted test and confirm that it fails for the expected reason.
4. If it passes before production code changes, improve the test until it proves the missing behavior.
5. Implement only enough production code to make the test pass.
6. Run the targeted test and confirm that it passes.
7. Refactor names, structure, duplication, and boundaries while keeping tests green.
8. Run the affected package test suite.
9. Run the repository quality gates before declaring the work complete.

Never write production behavior first and add tests afterward. Never weaken an existing assertion merely to make a change pass. Every bug fix requires a regression test that fails without the fix.

Documentation-only edits and mechanically generated artifacts do not require a failing test, but they must pass all applicable formatting, linting, generation-drift, and link checks.

## What to test

Test meaningful product behavior rather than maximizing a coverage percentage.

Every relevant change must protect:

- Normal observable behavior
- Boundary and empty-input behavior
- Failure and retry behavior
- Persistence and idempotency
- Authorization and approval boundaries
- Size, time, step, and resource limits
- Cross-component contracts
- Previously reported regressions

Avoid tests coupled to private functions, incidental call order, formatting details, or live-model prose. Prefer public APIs, structured events, state transitions, persisted records, and user-visible outcomes.

Use deterministic clocks, seeded randomness, fixtures, and fake external adapters. Unit and integration tests must not depend on live Workers AI, mutable GitHub state, arbitrary sleeps, or an uncontrolled network.

## Product invariants

The following invariants are especially important and must remain covered.

### Agent

- A real Project Think turn can call multiple tools before producing its answer.
- Once an investigation begins, the Project Think step policy forces each next missing evidence
  capability before final text, retries a bounded evidence failure at most once, and recovers its
  phase from persisted tool history without double-counting current-step results.
- Trace inspection reads only the representative trace selected by the persisted receipt; a model
  cannot substitute a different trace identifier.
- The agent cannot propose a fix without telemetry and release evidence.
- Tool failures are bounded and visible to the model without corrupting persisted state.
- Step limits stop runaway loops.
- Tool results are size-bounded before entering context.
- Reports distinguish evidence, inference, confidence, and unknowns.
- Reconnection does not duplicate committed messages or side effects.

Do not assert exact natural-language output from a live model. Assert structured messages, selected tools, evidence references, approvals, and terminal state.

### Telemetry

- UX and trace durations use a single documented unit.
- Release comparisons use equivalent windows and minimum sample counts.
- Percentile and error calculations handle empty and boundary datasets.
- Trace parentage and critical-path calculations are correct.
- Query windows, rows, and serialized results are bounded.
- No agent tool accepts arbitrary SQL.

### Repository and release inspection

- Worker versions map to immutable Git SHAs.
- Repository content is read at an explicit commit.
- Workers platform fetch functions are invoked without rebinding their receiver.
- Path traversal, disallowed paths, oversized files, and excessive reads fail closed.
- Missing GitHub PR metadata degrades to an evidence-backed unknown rather than a fabricated answer.

### GitHub writes

- Writes are disabled by default.
- Missing, empty, and whitespace-only GitHub credentials are treated as absent and cannot select a
  live adapter or satisfy the write gate.
- Normal deploy and refresh tasks keep writes disabled. Only the explicit write-enable task may
  change that posture, and only after the remote `GITHUB_TOKEN` secret is verified before and after
  deployment.
- Any write-enable deployment or smoke failure after mutation begins must automatically redeploy the
  preserved evidence configuration with writes disabled and verify that public runtime posture
  without depending on Workers AI. An unverifiable rollback must expose both failures.
- GitHub token entry delegates directly to pinned Wrangler's TTY prompt. Tokens must never come from
  `gh`, command arguments, environment files, repository state, or chat.
- Explicit approval is required before every external write.
- Only the configured repository and allowlisted source paths can change.
- Base and blob SHAs prevent stale writes.
- An advanced base is accepted only when the allowlisted source has the same immutable blob and
  content as the evidenced regression commit; the new commit must parent the current base.
- File-count, byte-count, and changed-line limits are enforced server-side.
- Agent code, workflows, deployment configuration, and secrets are immutable.
- Draft PR creation is idempotent per incident.
- The agent has no merge capability.

### Remote deployment

- `mise run deploy` must preserve distinct baseline, degraded, and investigator Worker version IDs.
- Remote evidence must come from measured requests and retain immutable version-to-SHA attribution.
- Normal public deployment keeps GitHub writes disabled and never copies a local `gh` credential.
- Explicit write enablement must preserve measured evidence, record the expected posture, and leave
  keyed smoke preview-only with zero external writes.
- Deployment smoke endpoints require an unguessable repository-local key and return 404 without it.
- Deployment verification may retry the pre-execution smoke 404 while a rotated key propagates and
  may poll the keyed GET-only D1 evidence-readiness route on 404/503. That route cannot call Workers
  AI, remediation, GitHub, health, or telemetry writes. It must never retry a response that could
  follow Workers AI or another endpoint side effect.
- Reset operations may delete only the two measured release IDs recorded in validated deployment state.
- A deployed gate is not complete until public routes, runtime metadata, Workers AI evidence tools,
  structured report, no-write remediation preview, and write posture all pass.

### Bootstrap and teardown

- Supported hosts are macOS and Linux on ARM64 and x64.
- Supported shells are sh, Bash, Zsh, Fish, and Nu.
- Bootstrap, activation, and teardown use one executable POSIX implementation each; do not add
  shell-specific Fish or Nu lifecycle adapters.
- Bootstrap affects only its process and repository-local files. Activation confines environment
  changes to the launched project shell or command.
- Shell profiles and system installation paths are never modified.
- Declining consent performs no associated mutation.
- TTY settings are restored on every exit path.
- Bootstrap and teardown are idempotent.
- Teardown removes only project-owned resources.
- Bootstrap never starts Colima, spawns a replacement login shell, or changes the active Docker
  context.
- The optional project profile mounts only the repository root explicitly and requires 4 GiB of
  memory for the Vite/`workerd` stack.
- Container lifecycle code must fail closed on invalid ownership markers and retain recovery evidence
  after a partial start.
- Host `node_modules`, `.local`, and `.wrangler` state must never be reused inside the Linux
  container.

## Test layers

Use the lowest layer that proves the behavior, then add higher-level coverage only for important integration contracts.

- Unit tests cover calculations, validation, state machines, and pure policy.
- Worker integration tests cover D1, Durable Objects, service bindings, Think tools, and persistence.
- Shell contract tests cover bootstrap, activation, consent, and teardown in isolated temporary homes.
- Container contract tests cover the resolved Compose model, named-volume isolation, repeated
  lifecycle operations, pre-existing profile preservation, and failed-start recovery without a VM.
- End-to-end tests cover the complete deterministic investigation and draft-PR preview path.

Snapshots are acceptable for stable serialized protocols or rendered structures. Do not use snapshots as a substitute for behavioral assertions.

## Required commands

Run repository commands through the mise environment from the repository root.

During development:

```text
mise run test:watch
mise run test -- <target>
```

Before completion:

```text
mise run format:check
mise run lint
mise run typecheck
mise run test
mise run e2e
mise run container:check
mise run build
```

`mise run check` must aggregate all non-deployment quality gates suitable for CI.

Do not bypass pinned tools with globally installed alternatives. Do not replace project tasks with ad hoc commands in documentation or CI.

## TypeScript standards

- Enable strict TypeScript compiler options.
- Keep repository Node automation in `scripts/*.ts`; `.mjs` automation entrypoints are forbidden.
- Directly executed scripts must use only erasable TypeScript syntax supported by the pinned Node 24
  runtime. `erasableSyntaxOnly` stays enabled, and `tsc --noEmit` remains the type-safety gate because
  Node strips types without checking them.
- Preserve concrete types across Worker bindings, tools, D1 records, and GitHub responses.
- Do not introduce `any` when `unknown` plus validation is possible.
- Validate all external data at the boundary.
- Avoid non-null assertions unless an invariant is enforced immediately beforehand.
- `@ts-expect-error` requires a reason and a test demonstrating the exceptional boundary.
- Exhaustively handle discriminated unions.
- Keep side effects behind explicit interfaces so tests can substitute deterministic fakes.

## Linting and formatting

Formatting is automated and non-negotiable.

- Use the repository's canonical formatter for JavaScript, TypeScript, JSON, and JSONC.
- Lint Markdown structure and links where practical.
- Check POSIX shell with ShellCheck and format it with `shfmt`.
- Verify that Fish and Nu can launch the shared POSIX lifecycle entrypoints without shell-specific
  syntax or adapters.
- Treat every lint warning as an error.
- Do not add blanket ignores or disable rules at file or project scope.
- A narrow suppression must explain why it is safe and why the preferred construct cannot be used.
- Generated artifacts must be reproducible; CI must fail on generation drift.

## Change discipline

- Keep changes focused on one behavioral objective.
- Preserve unrelated user modifications.
- Do not perform destructive Git operations.
- Do not mix broad refactors into a behavioral change unless the refactor is required and protected by tests.
- Prefer small explicit modules and bounded interfaces over generic framework layers.
- Keep external tools narrow; never expose generic SQL, shell, filesystem, or GitHub write access to the model.
- Update documentation and examples when a public contract changes.

## Project-system alignment

After every meaningful change, use the repository-local `align-project-system` skill in `.agents/skills/align-project-system/`.

A meaningful change affects user-visible behavior, stored data, interfaces, agent tools or prompts, security boundaries, architecture, runtime versions, supported platforms, setup, testing, deployment, delivery scope, issue sequencing, or acceptance criteria.

Before declaring such work complete, assess and align:

- `IMPLEMENTATION_PLAN.md`
- the active GitHub milestone and every affected issue
- native GitHub blocked-by relationships
- the human-facing GitHub wiki and `README.md`
- root and relevant nested `AGENTS.md` files
- repository-local skills

Update only surfaces whose truth changed, but report that every surface was assessed. An issue may close only after its alignment checklist is complete.

When a planned change must diverge from an issue, update the issue scope and dependency graph before implementation continues. Do not let merged code become the only record of an architectural or product decision.

## Definition of done

Work is complete only when:

- The new or changed behavior was first demonstrated by a failing test.
- The failure was for the intended reason.
- The minimal implementation makes the test pass.
- Meaningful normal, boundary, failure, persistence, and safety invariants are covered.
- Relevant tests pass locally.
- Formatting, linting, strict type-checking, E2E, and build gates pass with zero warnings.
- No test is skipped, focused, or quarantined without an explicitly documented external blocker.
- No secrets, credentials, generated local state, or host-specific paths are committed.
- The final change is understandable and defensible line by line.
- The implementation plan, milestone issues and blockers, wiki/README, agent instructions, and skills were assessed and aligned.

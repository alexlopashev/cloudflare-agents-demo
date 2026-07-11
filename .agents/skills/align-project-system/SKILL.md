---
name: align-project-system
description: Reconcile meaningful project changes across implementation plans, GitHub milestone issues and blocked-by relations, the human-facing wiki and README, AGENTS.md instructions, and repository-local skills. Use after changes to product behavior, architecture, scope, interfaces, toolchains, deployment, security boundaries, contribution workflow, or delivery status, and before declaring related work complete.
---

# Align Project System

Keep the project's planning, execution, documentation, and agent-guidance surfaces consistent after meaningful change. Update only surfaces whose truth changed, but assess every surface explicitly.

## Workflow

1. Read the changed behavior and its evidence before editing alignment surfaces.
2. Inspect:
   - `README.md`
   - `IMPLEMENTATION_PLAN.md`
   - root and relevant nested `AGENTS.md` files
   - `.agents/skills/*/SKILL.md`
   - the active GitHub milestone, its issues, acceptance criteria, and dependency graph
   - the GitHub wiki home, architecture, roadmap, operations, and decision pages
3. Classify the change as product, architecture, interface, operations, security, workflow, or delivery-state impact.
4. Record which surfaces require updates and why the others remain valid.
5. Apply authorized updates using the repository's normal GitHub and wiki workflows.
6. Validate local documents, issue relationships, and wiki navigation.
7. Report the alignment evidence with links or file paths.

## Surface Rules

### Implementation plan

- Keep architectural decisions, runtime versions, scope gates, phases, and acceptance criteria current.
- Remove superseded plans instead of preserving conflicting alternatives.
- Reflect newly discovered constraints and explicit deferrals.

### GitHub milestone and issues

- Keep one actionable purpose per issue with explicit scope, non-goals, TDD expectations, and acceptance criteria.
- Use native blocked-by relations for real execution dependencies; do not encode dependencies only in prose.
- Update dependencies when sequencing changes.
- Keep every delivery issue assigned to the active milestone.
- Close an issue only when its acceptance criteria and required alignment checks are satisfied.

### Wiki and README

- Keep the wiki human-oriented: explain purpose, architecture, workflows, decisions, roadmap, and operations without agent-only instructions.
- Keep README concise: product promise, demo path, setup, core commands, architecture summary, and links to deeper material.
- Link canonical details instead of duplicating large sections that will drift.
- Update wiki navigation whenever pages are added, renamed, or removed.

### Agent instructions and skills

- Keep `AGENTS.md` authoritative for TDD, quality gates, security constraints, and definition of done.
- Update a skill when a repeated workflow or required sequence changes.
- Do not place human project documentation inside a skill.
- Validate every changed skill with the repository's skill validator.

## Meaningful Change Test

A change is meaningful when it affects at least one of:

- user-visible behavior or demo flow
- stored data, telemetry semantics, or migrations
- public or cross-package interfaces
- agent tools, prompts, model behavior, memory, or approvals
- security boundaries or external writes
- architecture, dependencies, runtime versions, or supported platforms
- setup, test, deployment, rollback, or operator workflows
- delivery scope, sequencing, blockers, or acceptance criteria

Formatting-only edits, typo corrections, and internal renames with no contract impact require an assessment but usually no cross-surface updates.

## Alignment Checklist

Before completion, answer each item explicitly:

- [ ] Does `IMPLEMENTATION_PLAN.md` still describe the implemented direction?
- [ ] Do milestone issue scopes and acceptance criteria match the change?
- [ ] Are native blocked-by relations still correct?
- [ ] Does the wiki explain the current system accurately to a human reader?
- [ ] Does README still provide the correct entry path?
- [ ] Do `AGENTS.md` rules remain sufficient and non-conflicting?
- [ ] Do repository-local skills still encode the current reusable workflows?
- [ ] Were applicable document, issue, wiki, skill, and code validations run?

If a surface is unchanged, record that it was assessed and why no edit was needed.

## Validation

- Run applicable local formatting, linting, test, and build gates.
- Validate changed skills with `quick_validate.py` or the repository wrapper.
- Query GitHub issues with `blockedBy`, `blocking`, and `milestone` fields and compare them with the intended graph.
- Inspect wiki links and sidebar navigation after publishing.
- Do not claim alignment when an inaccessible or unauthorized surface could not be checked; report it as a blocker.

External mutations still require authority from the active user request. An alignment obligation does not independently authorize issue, wiki, deployment, or repository writes.

# Repo Agent Rules

## Test File Rule

- All tests must live in dedicated sidecar test files.
- Do not define tests inline inside production source files such as `*.rs`, `*.ts`, or `*.tsx`.
- When adding tests for a source file, place them in a separate file named like `*.test.rs`, `*.test.ts`, or `*.test.tsx` and wire that file in explicitly when the language/module system requires it.

## Generalize The Constraint Rule

- When a user points out a bad solution pattern, do not write a rule only for that exact case; first abstract the underlying failure mode, then encode the rule at the highest level that still gives clear operational guidance.
- Do not optimize only for the immediate local symptom when the fix introduces future friction, such as duplicated logic, mirrored declarations, forwarding layers, adapter shims, compatibility glue, extra maintenance surfaces, or extension barriers.
- Before adding any new layer, file, wrapper, mapping, or indirection, check whether it creates a second source of truth, raises future change cost, or turns a one-place update into a multi-place update.
- Prefer solutions that preserve a single canonical definition and keep extension cost local and additive across languages and stacks, not only in the current file or technology.
- If a proposed fix solves the current issue but would make future evolution harder, stop and either find the more general structural fix or explicitly tell the user that the remaining option is a tradeoff.
- Case-specific rules are allowed only when the problem is truly unique to that mechanism; otherwise, encode the broader class of failures so the rule remains valid for future analogous cases.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **ransic** (2751 symbols, 6196 relationships, 231 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/ransic/context` | Codebase overview, check index freshness |
| `gitnexus://repo/ransic/clusters` | All functional areas |
| `gitnexus://repo/ransic/processes` | All execution flows |
| `gitnexus://repo/ransic/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

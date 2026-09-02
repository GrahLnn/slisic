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

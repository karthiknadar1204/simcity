---
name: tdd
description: Implement stateful engine behavior and bug fixes through a failing behavioral test, minimal implementation, and refactoring in the Simcity Bun workspace.
---

# Test first

Adapted from `neatlogs-prod/.agent/skills/tdd`. Its unrelated service paths and deployment workflows do not apply here.

1. Describe the input, observable outcome, and invariant. Run the existing relevant suite once to establish the baseline.
2. Add public types or throwing signatures if needed, then one behavioral test. Confirm it fails because the behavior is missing, rather than because an import or syntax is broken.
3. Implement the smallest change that passes. Run the scoped Bun test, then the relevant broader suite.
4. Refactor only with passing tests. Repeat for the next behavior.

Use colocated `*.test.ts` files. Commands are `bun test packages/<name>/src/<file>.test.ts`, `bun run test`, `bun run check-types`, `bun run lint`, and `bun run build`. Integration checks that require live services use explicit scripts and isolated run IDs. Do not mutate existing worlds to test a fixture.

Prefer real transitions and real values. Test conservation, information boundaries, chronology, replay equality, ownership fencing, and retry behavior. Mock only unavailable external I/O. Never weaken an assertion or hide a failure to pass.

Do not commit credentials or generated runtime data. Commit and push when the user has authorized it, using logical working milestones.

# Autonomous Development Platform — Agent Rules

The product owner supplies intent and only returns for final owner review.

## Non-negotiable workflow
- Do not ask the owner ordinary architecture, UX, library, naming, implementation, or testing questions.
- Resolve normal ambiguity internally using platform conventions and the Council specification.
- Cursor is the execution engine, not the product authority.
- Do not mark a project ready merely because code was written.
- READY_FOR_OWNER_REVIEW requires implementation, build/test evidence, runtime verification appropriate to the platform, review, correction of material findings, and final release verification.
- Preserve existing behavior and architecture when modifying an existing repository unless a change is justified by the specification.
- Never disable tests or safety controls merely to make a build pass.
- Never commit credentials or secrets.

## Evidence returned from implementation
Every implementation run should return changed files, commands/tests run, results, build status, runtime verification, generated artifacts/screenshots when available, deviations from the specification, and unresolved issues.

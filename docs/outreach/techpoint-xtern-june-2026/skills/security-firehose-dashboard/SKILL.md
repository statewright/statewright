# Security Firehose Dashboard Skill

Use this skill when working on the TechPoint Xtern incident signal dashboard exercise.

## Mission

Turn simulated security events into incident-level signal. The implementation is complete when `npm test` passes and the Vue dashboard consumes the API endpoints defined in `spec.md`.

## Workflow

1. Read `README.md`, `spec.md`, `src/backend/*.test.mjs`, and `src/backend/etl.mjs`.
2. Run `npm test` before editing.
3. Fix backend ETL behavior first.
4. Preserve the API routes in `src/backend/server.mjs`.
5. Improve `public/app.js` only after the data contract is correct.

## Completion Rules

- Do not invent new input data to make tests pass.
- Do not remove or weaken tests.
- Keep the implementation deterministic.
- Prefer small pure functions in `src/backend/etl.mjs`.
- Run `npm test` after changes.

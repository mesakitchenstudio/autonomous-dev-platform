# Autonomous AI Development Platform

A domain-agnostic orchestration foundation for this contract:

**Owner idea → independent multi-model Council → Council Chair → Cursor implementation → evidence → multi-model review → automatic correction loops → final release verification → platform completion gate → owner review.**

The owner is intentionally absent from normal engineering loops.

## What Phase 1 includes

- Persistent project state stored as atomic JSON files, with operation checkpoints.
- Authoritative state transitions (no silent state assignment in the normal workflow).
- Boot-time recovery of in-flight projects; FAILED projects resume only via explicit retry.
- Four provider adapters: OpenAI, Anthropic, Gemini, and xAI.
- Independent Council analysis before Chair synthesis. No majority voting.
- Cursor ACP client (`agent acp` JSON-RPC) and Cursor Cloud Agents client.
- Canonical execution evidence with provenance: `MOCK`, `CURSOR_REPORTED` / `SELF_REPORTED`, `PLATFORM_VERIFIED`.
- Deterministic completion gate: Chair `COMPLETE` alone cannot mark a project ready.
- Configurable timeouts for AI providers, ACP runs, Cloud HTTP, and Cloud polling.
- Structured error records (`code`, `phase`, `retryable`, timestamp).
- ACP permission policy (`deny` | `safe-development` | `allow-all`). Default is **not** allow-all.
- Cursor child processes do not inherit Council provider API keys.
- Cross-platform demo: `npm run demo` (Windows, macOS, Linux).
- Minimal web control panel.

Demo mode can still reach `READY_FOR_OWNER_REVIEW`. That result is explicitly `verificationLevel: MOCK` and is not a real application build.

## Run demo

```bash
npm run demo
```

Open http://localhost:4317, submit an idea, and watch the project move to `READY_FOR_OWNER_REVIEW` with MOCK verification.

## Run with real providers + Cursor ACP

1. Install and authenticate Cursor CLI (`agent login`) or configure a Cursor API/auth token.
2. Copy `.env.example` to `.env`.
3. Add all four AI provider API keys.
4. Set `CURSOR_PROJECT_PATH` to the repository Cursor should implement into, or enter a repository path in the UI.
5. Run:

```bash
npm start
```

With `STRICT_COUNCIL=true`, all four providers must be configured.

## Recovery

If the Node process stops after a state is persisted:

| Persisted state | Restart behavior |
|---|---|
| `IDEA_SUBMITTED` / `COUNCIL_DISCOVERY` | Re-run discovery unless a valid specification already exists |
| `SPECIFICATION_READY` | Start the next Cursor implementation run |
| `CURSOR_EXECUTING` | Replay the unfinished Cursor run; do not skip review |
| `COUNCIL_REVIEW` | Finish review from the last Cursor evidence; do not skip final verification |
| `FINAL_VERIFICATION` | Finish final verification, then the platform completion gate |
| `READY_FOR_OWNER_REVIEW` / `OWNER_APPROVED` | Terminal — not auto-resumed |
| `FAILED` | Not auto-retried. `POST /api/projects/:id/retry` resumes from the safest checkpoint without discarding history |

Recovery never treats a Cursor response as project completion.

## Evidence and completion

`READY_FOR_OWNER_REVIEW` requires all of:

- a valid Chair specification
- at least one completed Cursor execution
- a canonical evidence object
- execution status not `FAIL`
- Council review `COMPLETE`
- final verification `COMPLETE`
- no unresolved orchestration error
- iteration limit not exceeded

The Council Chair cannot bypass this gate.

Phase 1 does **not** independently run builds, tests, browsers, or emulators. Evidence is usually `SELF_REPORTED` (live Cursor) or `MOCK` (demo). `PLATFORM_VERIFIED` is reserved for later phases.

## Timeouts

| Variable | Default | Applies to |
|---|---|---|
| `AI_REQUEST_TIMEOUT_MS` | 120000 | Council provider requests |
| `CURSOR_REQUEST_TIMEOUT_MS` | 600000 | ACP runs and Cloud HTTP requests |
| `CURSOR_CLOUD_RUN_TIMEOUT_MS` | 1800000 | Cloud run polling (not infinite) |

A timeout fails the in-flight operation, records a structured error, and leaves the project in `FAILED` rather than permanently `CURSOR_EXECUTING`.

## ACP permission policy

`ACP_PERMISSION_POLICY` defaults to `safe-development`:

- `deny` — reject permission and plan requests
- `safe-development` — allow common file/search kinds; deny execute/terminal/network/unknown
- `allow-all` — explicit development override only

Permission decisions are persisted on the project when the ACP client reports them.

## Architecture

```text
Owner UI
  │
  ▼
Orchestrator / JSON state / checkpoints
  │
  ├─ OpenAI ─────┐
  ├─ Anthropic ──┤ independent analysis/review
  ├─ Gemini ─────┤
  └─ xAI ────────┘
          │
          ▼
     Council Chair
          │
          ▼
   Cursor ACP or Cloud
          │
          ▼
   Canonical evidence → Council review → completion gate
```

## Still later phases (not implemented)

- Council debate rounds and production provider schema/retry
- PostgreSQL / durable external job queue
- Independent build/test/CI artifact collection
- Browser, Android emulator, iOS simulator, screenshot, and visual AI review
- Git worktree isolation and new-project starters
- Credential vault, full sandbox/container policy
- Owner notifications and approval UI

### Cursor Cloud mode

Set:

```bash
CURSOR_MODE=cloud
CURSOR_API_KEY=...
CURSOR_REPO_URL=https://github.com/your-org/your-repo
CURSOR_STARTING_REF=main
```

The orchestrator creates one Cursor Cloud agent and sends later correction prompts as additional runs. Polling stops at a terminal status or `CURSOR_CLOUD_RUN_TIMEOUT_MS`.

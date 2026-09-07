# Autonomous AI Development Platform

A domain-agnostic orchestration foundation for this contract:

**Owner idea → independent multi-model Council → Council Chair → Cursor implementation → evidence → multi-model review → automatic correction loops → final release verification → platform completion gate → owner review.**

The owner is intentionally absent from normal engineering loops.

## What Phase 1 and Phase 2 include

- Persistent project state with operation checkpoints (now durable PostgreSQL in production).
- Authoritative state transitions (no silent state assignment in the normal workflow).
- Boot-time recovery of in-flight projects; FAILED projects resume only via explicit retry.
- Four provider adapters: OpenAI, Anthropic, Gemini, and xAI, on a shared retry/timeout path.
- Independent Council analysis, anonymized critique, optional resolution, then Chair synthesis. No majority voting.
- Cursor ACP client (`agent acp` JSON-RPC) and Cursor Cloud Agents client.
- Canonical execution evidence with provenance: `MOCK`, `CURSOR_REPORTED` / `SELF_REPORTED`, `PLATFORM_VERIFIED`.
- Deterministic completion gate: Chair `COMPLETE` alone cannot mark a project ready.
- Configurable timeouts for AI providers, ACP runs, Cloud HTTP, and Cloud polling.
- Structured error records (`code`, `phase`, `retryable`, timestamp).
- ACP permission policy (`deny` | `safe-development` | `allow-all`). Default is **not** allow-all.
- Cursor child processes do not inherit Council provider API keys.
- Cross-platform demo: `npm run demo` (Windows, macOS, Linux).
- Minimal web control panel.

Demo mode can still reach `READY_FOR_OWNER_REVIEW`. That result is explicitly `verificationLevel: MOCK` and is not a real application build. The demo Council now runs independent analysis, critique, Chair synthesis, and at least one Cursor correction cycle before final COMPLETE.

## Run demo

```bash
npm run demo
```

Open http://localhost:4317, submit an idea, and watch the project move to `READY_FOR_OWNER_REVIEW` with MOCK verification.

Demo without `DATABASE_URL` uses an isolated PGlite store plus an in-process worker. That is still `verificationLevel: MOCK`. It is not the production PostgreSQL path.

## Durable execution (Phase 3)

Production persistence is PostgreSQL. It is the source of truth for projects, jobs, leases, Council records, Cursor runs, evidence, and events.

PGlite remains a development/test implementation for fast unit tests, the default demo when `DATABASE_URL` is unset, and local convenience. PGlite concurrency tests are **not** equivalent to production PostgreSQL validation. Queue locking, `FOR UPDATE SKIP LOCKED`, and multi-process worker behavior are verified against a real PostgreSQL server by `npm run test:postgres`.

The API process no longer runs Council/Cursor inline. It writes a project and a durable job, then returns. A worker claims jobs with `FOR UPDATE SKIP LOCKED`, heartbeats a lease, and hands off the next job in the same transaction as completion.

```bash
# Local PostgreSQL (Docker)
docker compose up -d
# then set DATABASE_URL=postgres://adp:adp@127.0.0.1:5432/adp

# Or a local Postgres-compatible engine without Docker
npm run db

npm run migrate
npm start          # API only
npm run worker     # autonomous worker
npm run demo       # combined API + worker, MOCK verification
```

`DATABASE_URL` is required outside `DEMO_MODE`. The platform does not silently fall back to JSON files when Postgres is unavailable.

Delivery is **at-least-once**. Operations use idempotency keys such as `project:<id>:cursor:<iteration>`. A crash after Cursor has changed files but before the platform records completion is recovered from Git checkpoints when possible; uncommitted interrupted work is preserved and never reset automatically.

JSON files in `DATA_DIR` are legacy. Import them with `npm run import-json` (idempotent; originals are not deleted). Archive them manually after you confirm the import.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | unset | Production PostgreSQL URL |
| `WORKER_POLL_MS` | 400 | Worker poll interval |
| `WORKER_CONCURRENCY` | 1 | In-process jobs per worker |
| `JOB_LEASE_MS` | 900000 | Running-job lease |
| `JOB_HEARTBEAT_MS` | 30000 | Lease renewal interval |
| `JOB_MAX_ATTEMPTS` | 8 | Then the job is dead-lettered |
| `JOB_RETRY_BASE_MS` / `JOB_RETRY_MAX_MS` | 2000 / 60000 | Scheduled job backoff |

`GET /health` is liveness. `GET /ready` checks the database and returns safe job counts. `GET /api/projects/:id/export` dumps one project for diagnostics (no API keys).

```bash
# Isolated PostgreSQL integration suite (refuses non-test database names)
npm run test:postgres
# or: TEST_DATABASE_URL=postgres://USER@127.0.0.1:5432/adp_phase3_test npm run test:postgres
```

`npm test` runs only `test/*.test.js` on the fast PGlite/in-memory path. It does not start PostgreSQL and will not open `DATABASE_URL` or a production database.

## Cursor isolation (Phase 4)

Real Cursor execution never uses the owner's ordinary worktree as `cwd`. An existing local Git repository is isolated into a managed worktree on a deterministic branch `adp/<project-id>` under `MANAGED_WORKSPACE_ROOT` (default `./workspaces`). The owner's committed baseline is the comparison point. Uncommitted owner files stay in the owner tree and are not copied into the autonomous task.

ACP, Cloud, and Mock share one normalized Cursor contract (session/agent/run IDs, workspace, Git snapshot, changed-file manifest, uncertainty). The platform collects Git status/diff itself after local runs and marks the Git aspect `PLATFORM_VERIFIED`. Phase 5 independently runs detected build/test/lint commands.

After a successful local iteration the platform creates a checkpoint commit (`ADP iteration N`) on the autonomous branch. `.env`, keys, and similar secret files are not committed. Correction loops resume the same worktree, branch, and ACP session when `session/load` still works. If conversational memory is gone, a new session is created in the same repository state.

Cloud execution is per-project (`repository` / `baseRef` on the project), with `workOnCurrentBranch=false` and `autoCreatePR=false`. Agent and run IDs are persisted so a restarted worker can resume polling. Platform AI keys and `DATABASE_URL` are never forwarded into the Cursor child or Cloud session environment.

### Local ACP requires

- Cursor CLI (`CURSOR_AGENT_BIN`, default `agent`) installed and authenticated
- Git
- The development tools the target repository already needs (Phase 4 does not install SDKs)

### Cloud requires

- Cursor API credentials (`CURSOR_API_KEY` / `CURSOR_CLOUD_API_KEY`)
- A per-project repository URL and starting ref
- Source-control integration and a Cloud environment that can actually build the project

| Variable | Default | Meaning |
|---|---|---|
| `CURSOR_MODE` | `acp` | `acp` \| `cloud` (persisted per project after the first run) |
| `CURSOR_PERMISSION_POLICY` / `ACP_PERMISSION_POLICY` | `safe-development` | `deny` \| `safe-development` \| `allow-all` |
| `MANAGED_WORKSPACE_ROOT` | `./workspaces` | Isolated worktrees only |
| `AUTONOMOUS_BRANCH_PREFIX` | `adp` | Branch prefix `adp/<project-id>` |
| `PROTECTED_BRANCH_PATTERNS` | `main,master,production,release/*` | Direct writes rejected |
| `CURSOR_CLOUD_AUTO_CREATE_PR` | `false` | Do not open a PR per correction |
| `CURSOR_CLOUD_WORK_ON_CURRENT_BRANCH` | `false` | Do not write the starting ref |
| `CURSOR_PROJECT_ENV_ALLOW` | empty | Project runtime env names only |

## Platform verification (Phase 5)

After each Cursor iteration the worker runs a durable `PLATFORM_VERIFICATION` job in the managed worktree against the checkpoint commit. Cursor's claim that a build or test passed is not evidence.

The platform detects Node, Gradle, Maven, Python, Rust, Go, and .NET tooling, derives a conservative plan from repository files (it does not invent missing scripts), installs dependencies when needed, then runs build → tests → lint/static/security. Commands are `spawn(argv)` inside the isolated workspace with filtered env, timeouts, and bounded logs stored under `ARTIFACT_ROOT`.

Successful independently executed steps are marked `PLATFORM_VERIFIED`. Overall `verificationLevel` may become `PLATFORM_VERIFIED` for those technical aspects. Runtime and visual are Phase 6 first-class stages. Demo mode stays `MOCK` and does not run real builds or browsers.

Required FAIL / NOT_RUN / UNKNOWN blocks `READY_FOR_OWNER_REVIEW`. The Chair cannot override that gate. Failed required verification still goes to Council review, which must produce a correction prompt; Cursor continues on the same autonomous branch and the next checkpoint is re-verified.

New projects are provisioned before Cursor starts feature work. Existing repositories skip generators and continue to use isolated worktrees.

| Variable | Default | Meaning |
|---|---|---|
| `VERIFY_INSTALL_TIMEOUT_MS` | 300000 | Dependency install timeout |
| `VERIFY_BUILD_TIMEOUT_MS` | 300000 | Build timeout |
| `VERIFY_TEST_TIMEOUT_MS` | 300000 | Test timeout |
| `VERIFY_LINT_TIMEOUT_MS` | 180000 | Lint/static/security timeout |
| `VERIFY_OUTPUT_PREVIEW_BYTES` | 8000 | DB preview size |
| `VERIFY_MAX_LOG_BYTES` | 1000000 | Full log cap |
| `VERIFY_SECURITY_ENABLED` | true | Optional lockfile audit when supported |
| `ARTIFACT_ROOT` | `./artifacts` | Verification logs/output metadata |
| `VERIFICATION_CONCURRENCY` | 1 | Worker-side verification cap |

## Run with real providers + Cursor ACP

1. Install and authenticate Cursor CLI (`agent login`) or configure a Cursor API/auth token.
2. Copy `.env.example` to `.env`.
3. Add all four AI provider API keys and `DATABASE_URL`.
4. Set `CURSOR_PROJECT_PATH` to the repository Cursor should implement into, or enter a repository path in the UI.
5. Run `npm start` and `npm run worker`.

With `STRICT_COUNCIL=true`, all four providers must be configured.

## Recovery

If the API or worker process stops after a state is persisted, jobs and leases remain in PostgreSQL:

| Persisted state | Restart behavior |
|---|---|
| `IDEA_SUBMITTED` / `COUNCIL_DISCOVERY` | Re-run discovery unless a valid specification already exists |
| `SPECIFICATION_READY` | New projects enter provisioning. Existing repositories start Cursor. |
| `PROJECT_PROVISIONING` | Resume or reuse the provisioning plan. A completed baseline is not regenerated. |
| `CURSOR_EXECUTING` | Inspect the isolated worktree. A matching checkpoint is not rerun. Uncommitted interrupted changes are preserved and marked `RECOVERY_REQUIRED`. Never `reset --hard` / `clean` unknown work. Then enter platform verification. |
| `PLATFORM_VERIFICATION` | Replay or reuse verification for the same iteration + checkpoint SHA. Do not assume a STARTED run passed. |
| `RUNTIME_VERIFICATION` | Replay or reuse runtime QA for the same iteration + checkpoint + artifact hash. |
| `VISUAL_VERIFICATION` | Replay or reuse visual review for the same runtime run + screenshot set hash. |
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
- for real projects: required platform verification is PASS or NOT_APPLICABLE (FAIL / NOT_RUN / UNKNOWN block READY)
- for UI projects that produced a required runtime plan: runtime launch and critical scenarios PASS, with no blocking accessibility defects
- for UI projects that require visual review: screenshot coverage completed, visual Council COMPLETE, no unresolved HIGH/CRITICAL visual findings
- stale runtime/visual evidence (old checkpoint or artifact hash) blocks READY
- backend/CLI visual may be `NOT_APPLICABLE`

The Council Chair cannot bypass this gate. Phase 5 technical verification is not product-acceptance proof. AI visual judgment is `AI_REVIEWED`; platform screenshot capture is `PLATFORM_VERIFIED`.

## AI Council (Phase 2)

```text
Owner idea
  → Round 1 independent analysis (models do not see each other)
  → Round 2 anonymized critique (Proposal A/B/C/D)
  → optional resolution if material disagreements remain
  → Council Chair synthesis (technical merit, not votes)
  → one validated Cursor prompt
```

- Responses are schema-validated. Malformed JSON gets one bounded repair retry, then is dropped.
- A temporary non-Chair failure is tolerated when `MIN_COUNCIL_RESPONSES` (default 2) still succeed.
- Chair failure, all-member failure, or an invalid specification after repair fails the project.
- `CHAIR_PROVIDER` and `CHAIR_MODEL` are independently configurable.
- Provider retries: `AI_MAX_RETRIES` (default 2) with backoff for 429/5xx/timeouts. 401/403 are not retried.
- Council history, participation, disagreements, and token usage (when the provider returns it) are persisted on the project. They are not shown in the owner workflow.
- Post-Cursor review findings are structured. `CHANGES_REQUIRED` needs `nextCursorPrompt`. COMPLETE cannot keep HIGH/CRITICAL blocking findings. A valid minority HIGH/CRITICAL finding cannot be ignored just because more reviewers voted COMPLETE.

| Variable | Default | Meaning |
|---|---|---|
| `MIN_COUNCIL_RESPONSES` | 2 | Minimum valid member responses per round |
| `MAX_COUNCIL_REASONING_ROUNDS` | 3 | Hard cap on analysis + critique + resolution |
| `AI_RESPONSE_REPAIR_ATTEMPTS` | 1 | Schema repair tries after the first response |
| `AI_MAX_RETRIES` | 2 | HTTP/transient retries per call |
| `AI_RETRY_BASE_MS` / `AI_RETRY_MAX_MS` | 400 / 4000 | Backoff window |

Phase 5 independently runs detected build/test/lint commands and can mark those aspects `PLATFORM_VERIFIED`. Runtime and visual remain later phases. Demo evidence stays `MOCK`.

## Timeouts

| Variable | Default | Applies to |
|---|---|---|
| `AI_REQUEST_TIMEOUT_MS` | 120000 | Council provider requests |
| `CURSOR_REQUEST_TIMEOUT_MS` | 600000 | ACP runs and Cloud HTTP requests |
| `CURSOR_CLOUD_RUN_TIMEOUT_MS` | 1800000 | Cloud run polling (not infinite) |

A timeout fails the in-flight operation, records a structured error, and leaves the project in `FAILED` rather than permanently `CURSOR_EXECUTING`.

## ACP permission policy

`ACP_PERMISSION_POLICY` / `CURSOR_PERMISSION_POLICY` defaults to `safe-development`:

- `deny` — reject permission and plan requests
- `safe-development` — allow reads/edits/search inside the managed workspace, plus classified project-local commands (build, test, package manager, safe Git). Deny workspace escapes, owner-tree writes, secret-file edits, destructive Git, force-push, protected-branch writes, system/destructive commands, and unknown permission kinds. This is not allow-all.
- `allow-all` — explicit development override only

Permission decisions are persisted on the project when the ACP client reports them. Unknown types default to reject.

## Architecture

```text
Owner UI
  │
  ▼
API (persist project + enqueue job)
  │
  ▼
PostgreSQL (projects, jobs, leases, Council, Cursor, events)
  │
  ▼
Worker(s) claim jobs
  │
  ├─ OpenAI ─────┐
  ├─ Anthropic ──┤ independent analysis → critique → optional resolution
  ├─ Gemini ─────┤
  └─ xAI ────────┘
          │
          ▼
     Council Chair (configurable provider/model)
          │
          ▼
   Cursor ACP or Cloud
          │
          ▼
   Platform verification (build/test/lint)
          │
          ▼
   Runtime verification (launch, scenarios, a11y, screenshots)
          │
          ▼
   Visual verification (multimodal Council, no majority vote)
          │
          ▼
   Canonical evidence → Council review → completion gate
```

Closing the browser or stopping the API does not stop a worker that still has database access.

## Runtime and visual QA (Phase 6)

After required Phase 5 technical verification, the worker runs durable `RUNTIME_VERIFICATION` and, when the application has a visual UI, `VISUAL_VERIFICATION`. These are independent stages with their own leases, heartbeats, idempotency keys, and evidence records. They operate on the exact Cursor checkpoint that passed Phase 5.

The platform owns the Playwright harness. Generated apps do not need their own Playwright tests. Chromium is the default required browser; Firefox/WebKit are optional. Install platform browsers explicitly:

```bash
npm run setup:browsers
```

The platform will not download browsers during an ordinary owner project unless `PLAYWRIGHT_INSTALL_ON_PROJECT=true`.

| Surface | Adapter | Visual |
|---|---|---|
| Web UI | Playwright Chromium (Firefox/WebKit optional) | Required |
| Backend / API | Process launch + HTTP smoke | `NOT_APPLICABLE` |
| CLI | Bounded entry commands | `NOT_APPLICABLE` |
| Android | Architecture + SDK/emulator discovery | Required when infrastructure exists |
| iOS / macOS | Architecture + `xcodebuild` / `simctl` | Required on a macOS worker |
| Desktop | Detection-only boundary | Not marked verified unless launched |

Unsupported mobile infrastructure is reported truthfully:

- Android without SDK/emulator: `ANDROID RUNTIME — NOT VERIFIED — INFRASTRUCTURE UNAVAILABLE`
- iOS on Windows/Linux: `IOS RUNTIME — NOT VERIFIED — MACOS/XCODE REQUIRED`

Workers advertise capabilities (`WEB_CHROMIUM`, `ANDROID_SDK`, `IOS_SIMULATOR`, `VISION_REVIEW`, …). A job that requires iOS is not claimed by a Windows worker; it stays queued for compatible infrastructure.

AI cannot emit arbitrary browser or shell actions. Scenarios use a validated DSL (`NAVIGATE`, `CLICK`, `FILL`, `ASSERT_*`, `SCREENSHOT`, …). Screenshots are artifacts with SHA-256, viewport, and checkpoint metadata — not PostgreSQL blobs. Automated accessibility uses wording such as `AUTOMATED_ACCESSIBILITY_CHECKS_PASS`, never `WCAG_CERTIFIED`.

A UI fix always reruns Phase 5 before Phase 6. The owner is not asked to review intermediate screenshots.

| Variable | Default | Meaning |
|---|---|---|
| `RUNTIME_READY_TIMEOUT_MS` | 30000 | HTTP readiness timeout |
| `RUNTIME_MAX_SCENARIOS` | 8 | Bounded scenario count |
| `VISUAL_MAX_SCREENSHOTS` | 12 | Images sent to visual review |
| `VISUAL_CRITICAL_REVIEWERS` | 3 | Vision-capable reviewers for critical screens |
| `VISUAL_SECONDARY_REVIEWERS` | 1 | Reviewers for secondary screens |
| `PLAYWRIGHT_INSTALL_ON_PROJECT` | false | Allow browser download during a project |

## New-project provisioning (Phase 7)

A new owner idea no longer stays `UNPROVISIONED_NEW_PROJECT`. After the Council produces a specification, the Chair's architecture choice is mapped to an approved provisioner. AI text is never executed as a scaffold command.

```text
Owner idea → Council specification → provisioning plan → generator
→ validation → secret check → ADP provisioning baseline
→ starter technical verification → Cursor feature implementation
```

Existing repositories skip this stage entirely.

### Live-supported on a typical Node worker

| Template | Provisioner | Notes |
|---|---|---|
| `web.react.vite.typescript` | Vite (`npm create vite`) | Official generator; resolved `vite` version is recorded |
| `web.next.typescript` | Next.js (`create-next-app`) | App Router + TypeScript |
| `backend.node.typescript` | Platform-owned Node template `1.0.0` | JavaScript health API, tests, `.env.example` |
| `cli.node` | Platform-owned CLI template `1.0.0` | Deterministic, no network generator |

This Windows worker live-verified Vite (`vite` 8.2.2, `react-ts`) and Next.js (`create-next-app` 16.3.4). Re-run official generators with `ADP_LIVE_PROVISION=1 npm run test:provisioning-live`.

### Capability-dependent

| Template | Required worker capabilities |
|---|---|
| Native Android | `ANDROID_SDK`, `ANDROID_PROJECT_CREATOR`, `JAVA` — not live-verified on this Windows worker |
| Flutter | `FLUTTER_SDK` — not live-verified unless the SDK is installed |
| Python backend | `PYTHON` |
| Rust / Go / .NET | matching toolchain |

### Detection-only / not live on Windows

iOS native provisioning requires a macOS/Xcode worker. A Windows worker will not claim that job and will not fabricate an `.xcodeproj`. Explicit "iOS app" product intent is not silently rewritten to Android.

Demo mode uses a mock provisioner so `npm run demo` stays `MOCK` and does not download generators.

| Variable | Default | Meaning |
|---|---|---|
| `DEFAULT_APP_ORGANIZATION` | `com.autonomous.generated` | Android/Flutter organization prefix |
| `PROVISIONER_VERSION_POLICY` | `CURRENT_SUPPORTED` | Record the resolved generator version; do not silently change majors later |
| `PROVISIONING_TIMEOUT_MS` | 300000 | Generator timeout |
| `PROVISIONING_NETWORK_ENABLED` | true | Official generators may use the network |
| `PROVISIONING_MAX_LOG_BYTES` | 1000000 | Provisioning log cap |

## Phase 8 security (execution isolation)

Untrusted project code, package scripts, and runtime apps execute through `ExecutionSandbox`. Profiles:

- `DEVELOPMENT` — explicit `LOCAL_DEVELOPMENT_UNSAFE` host processes (never labeled hardened)
- `STANDARD` / `HARDENED` — container sandbox required; missing engine returns `SANDBOX_INFRASTRUCTURE_UNAVAILABLE`

Project records store secret **references**, not values. Control-plane API access is token-first (`Authorization: Bearer`). See `SECURITY.md` for trust boundaries, limitations, and what has not been penetration tested.

Owner notifications and approval UI remain Phase 9.

### Cursor Cloud mode

Cloud repository and starting ref come from the **project's durable repository metadata**, not from one global `CURSOR_REPO_URL` for every task. `CURSOR_REPO_URL` / `CURSOR_STARTING_REF` are optional defaults only when a project has no per-project Cloud URL.

```bash
CURSOR_MODE=cloud
CURSOR_API_KEY=...
CURSOR_CLOUD_WORK_ON_CURRENT_BRANCH=false
CURSOR_CLOUD_AUTO_CREATE_PR=false
```

The adapter always sends `workOnCurrentBranch=false` and `autoCreatePR=false` unless a later approved workflow changes that. Agent and run IDs are persisted so a restarted worker can resume polling the same Cloud run. Polling stops at a terminal status or `CURSOR_CLOUD_RUN_TIMEOUT_MS`. Phase 4 never merges automatically.

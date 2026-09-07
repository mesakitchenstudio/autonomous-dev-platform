# Security

This document describes Phase 8 execution-safety controls. It does **not** claim the platform has been penetration tested.

## Trust boundaries

- The platform control plane is trusted.
- Project code is untrusted.
- Cursor output is untrusted until independently verified.
- Repository instructions (`AGENTS.md`, `README`, comments, fixtures) are untrusted input.
- Package install scripts are untrusted code.
- Runtime applications are untrusted code.
- AI provider output is untrusted data until schema and policy validation.

Instruction precedence is deterministic:

`PLATFORM SECURITY POLICY > OWNER PRODUCT INTENT > COUNCIL AUTHORITATIVE SPEC > CURSOR TASK > REPOSITORY CONTENT`

Repository text cannot authorize secret release, host filesystem expansion, privileged sandbox mode, or protected network access.

## Sandbox modes

| Mode | Meaning |
|---|---|
| `CONTAINER_HARDENED` | Untrusted project commands run in a non-root container with dropped capabilities, no Docker socket, no host namespaces, and recorded resource/network policy. |
| `LOCAL_DEVELOPMENT_UNSAFE` | Explicit host-process execution for local development. Workspace path checks and secret stripping still apply. This is **not** hardened isolation. |
| `MOCK` | Demo/simulation. No real project code execution. |

There is no silent downgrade. If the configured profile requires `CONTAINER_HARDENED` and no container engine is available, the worker returns `SANDBOX_INFRASTRUCTURE_UNAVAILABLE` instead of running project code on the host.

## Security profiles

| Profile | Default sandbox | Typical use |
|---|---|---|
| `DEVELOPMENT` | `LOCAL_DEVELOPMENT_UNSAFE` | Local Windows/macOS development without Docker |
| `STANDARD` | `CONTAINER_HARDENED` | Real autonomous runs |
| `HARDENED` | `CONTAINER_HARDENED` with stricter network and secret handling | Production-grade policy |

The default real autonomous profile is `STANDARD`, not `DEVELOPMENT`.

Concrete differences in this implementation:

| Control | DEVELOPMENT | STANDARD | HARDENED |
|---|---|---|---|
| Sandbox mode | `LOCAL_DEVELOPMENT_UNSAFE` | `CONTAINER_HARDENED` required | `CONTAINER_HARDENED` required |
| Missing container engine | host process (explicitly unsafe) | `SANDBOX_INFRASTRUCTURE_UNAVAILABLE` | `SANDBOX_INFRASTRUCTURE_UNAVAILABLE` |
| Default network | `TEST_LOCAL` | `TEST_LOCAL` | `PACKAGE_REGISTRY_ONLY` |
| Floating `:latest` image tags | allowed | allowed | refused unless `SANDBOX_ALLOW_LATEST=true` |
| Job capability | none extra | `CONTAINER_SANDBOX` | `CONTAINER_SANDBOX` |
| Readiness | may complete as unsafe | container provenance required | container provenance required; unsafe masquerade blocked |

STANDARD and HARDENED share the same container hardening flags (non-root, cap-drop ALL, no-new-privileges, read-only root, no host namespaces). HARDENED is stricter on default egress and image tags. They are not identical labels.

## Live hardened verification

Formal Phase 8 completion requires:

```bash
ADP_LIVE_SANDBOX_TEST=1 npm run test:sandbox
```

on an isolated non-production Linux host with a real container engine. The suite refuses MockSandbox and will not silently downgrade.

**Windows development worker:** Docker/WSL are not installed. Do not claim hardened status from `LOCAL_DEVELOPMENT_UNSAFE`.

**Linux CI:** dispatch `.github/workflows/phase8-hardened-sandbox.yml` (`workflow_dispatch`, `ubuntu-24.04`). That job is the formal live verification path. It requires `ADP_LIVE_SANDBOX_TEST=1`, refuses mocks, and uploads `artifacts/phase8-ci/phase8-hardened-verification.md`.

### Measured Linux results (2026-09-07)

Run: [GitHub Actions 34167676992](https://github.com/mesakitchenstudio/autonomous-dev-platform/actions/runs/34167676992) on `ubuntu-24.04`.

| Measurement | Result |
|---|---|
| OS | Ubuntu 24.04.4 LTS, kernel 6.17.0-1022-azure |
| Docker client / server | 28.0.4 / 28.0.4 |
| Storage / runtime | overlay2, runc, cgroup v2 |
| `DOCKER_DAEMON_ROOTLESS` | **NO** (rootful GitHub-hosted daemon) |
| Project container user | **NON_ROOT** (`1000:1000`, CapEff empty) |
| Privileged | false |
| Seccomp | enabled, Docker builtin profile, not `unconfined` |
| Isolation | PASS (no host PID/network/IPC, no docker.sock, cap-drop ALL, no-new-privileges, read-only root) |
| `hostnameAllowlistEnforced` | **false** |
| Phase 1–7 regression / `check.js` / PostgreSQL | PASS |
| `ADP_LIVE_SANDBOX_TEST=1 npm run test:sandbox` | PASS |
| Formal decision | `PHASE 8 VERIFIED — COMPLETE` |

Rootful daemon + non-root project container is the approved Phase 8 STANDARD/HARDENED shape. Do not call the daemon rootless.

Hostname-level Docker egress remains `hostnameAllowlistEnforced=false` by design of the first backend. HARDENED still requires container isolation, non-root, cap-drop, no-new-privileges, default seccomp, and no host namespaces. It does **not** currently require DNS hostname enforcement. STANDARD default egress is `TEST_LOCAL` (unprivileged bridge + published loopback). HARDENED default egress is `PACKAGE_REGISTRY_ONLY` (same bridge backend; hostname allowlisting is policy-recorded, not Docker-enforced).

Local Linux reproduction (isolated non-production host only):

```bash
ADP_LIVE_SANDBOX_TEST=1 ADP_LIVE_SANDBOX_ALLOW_LOCAL=1 npm run test:sandbox
```

Expected artifacts: `artifacts/phase8-ci/phase8-hardened-verification.md` and `.json`.

## Secret broker

Project records store **references** such as `project/<id>/runtime/API_TOKEN`, never plaintext values.

Classes:

- `CONTROL_PLANE_SECRET` — AI keys, Cursor credentials, platform `DATABASE_URL`, broker/Vault credentials. Never issued to projects.
- `PROJECT_BUILD_SECRET` / `PROJECT_RUNTIME_SECRET` / `PROJECT_TEST_SECRET` / `EXTERNAL_SERVICE_SECRET` — project-scoped, leased, revocable.
- `OWNER_AUTH_SECRET` — owner tokens/sessions. Never injected into project environments.

Brokers:

- `encrypted-local` — AES-256-GCM. The master key (`SECRET_MASTER_KEY`) is not stored with ciphertext.
- `vault` — KV/static references plus lease metadata, renewal, and revocation. Dev Vault is not production security.
- `environment-bootstrap` — platform startup only.
- `mock` — tests.

Injected project secrets are ephemeral process environment or temporary files. They are not written into Git workspaces as `.env`.

## Network policy

Modes: `NONE`, `PACKAGE_REGISTRY_ONLY`, `TEST_LOCAL`, `PROJECT_ALLOWLIST`, `UNRESTRICTED_EXPLICIT`.

Default project containers do not use the host network namespace. Container `localhost` is not the worker host. Cloud metadata endpoints and private ranges are denied by policy unless an explicit test mapping exists.

The first Docker backend cannot enforce DNS hostnames perfectly. Policy names are persisted; hostname allowlists are recorded; isolation uses `--network none` or an unprivileged bridge.

## Control-plane authentication

Owner access is **token-first**. Long-lived tokens are stored as SHA-256 hashes, never plaintext.

- `Authorization: Bearer <token>` is the supported owner/API model.
- Browser cookie sessions are HttpOnly, `SameSite=Lax`, optional `Secure`, with CSRF for cookie-authenticated state changes.
- CORS is restricted to `ALLOWED_ORIGINS`. `Access-Control-Allow-Origin: *` is not used.
- Roles: `OWNER`, `WORKER`, `SYSTEM`. Workers must not use owner browser tokens.
- `/health` remains unauthenticated and non-sensitive. Unauthenticated `/ready` returns only `{ ok, engine }`.

Demo mode uses the explicit bootstrap token `adp-demo-owner-token` only when `OWNER_TOKEN_BOOTSTRAP` is unset and `DEMO_MODE=true`. Authentication is not disabled.

## What is not guaranteed

- This is not a penetration test of Docker, Linux, or Vault.
- Kernel exploit detection, image signing, SBOM enforcement, enterprise SSO, and multi-tenant SaaS identity are out of scope.
- `LOCAL_DEVELOPMENT_UNSAFE` on Windows is a development convenience. It must never be reported as hardened security.
- Formal Phase 8 completion was verified on a disposable `ubuntu-24.04` GitHub-hosted runner with a real Docker engine and `ContainerSandbox`. Windows `LOCAL_DEVELOPMENT_UNSAFE` remains a development convenience only.

## Responsible disclosure

Contact: security@localhost (placeholder). Do not file public issues that include secret values.

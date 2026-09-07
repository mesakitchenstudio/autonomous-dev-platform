export const MIGRATION_ID = '001_initial';

export const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY,
    idea TEXT NOT NULL,
    product_name TEXT,
    state TEXT NOT NULL,
    project_path TEXT,
    verification_level TEXT,
    iteration INTEGER NOT NULL DEFAULT 0,
    max_iterations INTEGER NOT NULL DEFAULT 12,
    demo BOOLEAN NOT NULL DEFAULT FALSE,
    active_prompt TEXT,
    delivery JSONB,
    error JSONB,
    checkpoint JSONB,
    permission_log JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    ready_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    imported_from_json BOOLEAN NOT NULL DEFAULT FALSE
  )`,

  `CREATE TABLE IF NOT EXISTS state_transitions (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    reason TEXT,
    details JSONB,
    at TIMESTAMPTZ NOT NULL,
    UNIQUE (project_id, at, from_state, to_state)
  )`,

  `CREATE TABLE IF NOT EXISTS operations (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    phase TEXT,
    iteration INTEGER,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT NOT NULL,
    input JSONB,
    result JSONB,
    error JSONB,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    UNIQUE (idempotency_key)
  )`,

  `CREATE TABLE IF NOT EXISTS council_rounds (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    phase TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    reasoning_round INTEGER,
    participants JSONB,
    responses JSONB,
    errors JSONB,
    disagreements JSONB,
    chair JSONB,
    mapping JSONB,
    at TIMESTAMPTZ NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS council_artifacts (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (project_id, kind, iteration)
  )`,

  `CREATE TABLE IF NOT EXISTS cursor_runs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    session_id TEXT,
    execution_mode TEXT,
    prompt_preview TEXT,
    status TEXT NOT NULL,
    stop_reason TEXT,
    output JSONB,
    evidence JSONB,
    error JSONB,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    UNIQUE (project_id, iteration, attempt)
  )`,

  `CREATE TABLE IF NOT EXISTS evidence_records (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cursor_run_id UUID REFERENCES cursor_runs(id) ON DELETE SET NULL,
    iteration INTEGER,
    verification_level TEXT NOT NULL,
    aspects JSONB NOT NULL,
    artifacts JSONB,
    warnings JSONB,
    errors JSONB,
    source JSONB,
    created_at TIMESTAMPTZ NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS error_records (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    code TEXT,
    message TEXT,
    phase TEXT,
    retryable BOOLEAN,
    details JSONB,
    at TIMESTAMPTZ NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY,
    project_id UUID,
    type TEXT NOT NULL,
    payload JSONB,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    phase TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL,
    payload JSONB,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 8,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by TEXT,
    lease_expires_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    last_error JSONB
  )`,

  `CREATE TABLE IF NOT EXISTS json_imports (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    source_path TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_project
    ON jobs (project_id) WHERE status IN ('QUEUED', 'RUNNING')`,

  `CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_idempotency
    ON jobs (idempotency_key) WHERE status IN ('QUEUED', 'RUNNING')`,

  `CREATE INDEX IF NOT EXISTS jobs_claim_idx
    ON jobs (priority, created_at) WHERE status = 'QUEUED'`,

  `CREATE INDEX IF NOT EXISTS jobs_lease_idx
    ON jobs (lease_expires_at) WHERE status = 'RUNNING'`,

  `CREATE INDEX IF NOT EXISTS transitions_project_idx ON state_transitions (project_id, at)`,
  `CREATE INDEX IF NOT EXISTS events_project_idx ON events (project_id, at)`,
  `CREATE INDEX IF NOT EXISTS cursor_runs_project_idx ON cursor_runs (project_id, iteration)`,
  `CREATE INDEX IF NOT EXISTS council_rounds_project_idx ON council_rounds (project_id, at)`
];

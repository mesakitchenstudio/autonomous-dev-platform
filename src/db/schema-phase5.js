export const PHASE5_MIGRATION_ID = '003_phase5_platform_verification';

export const PHASE5_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS verification_runs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL,
    checkpoint_sha TEXT,
    status TEXT NOT NULL,
    project_type TEXT,
    toolchains JSONB NOT NULL DEFAULT '[]'::jsonb,
    plan JSONB,
    policy JSONB,
    blocking_failures JSONB NOT NULL DEFAULT '[]'::jsonb,
    problems JSONB NOT NULL DEFAULT '[]'::jsonb,
    config_changed BOOLEAN NOT NULL DEFAULT FALSE,
    config_files JSONB NOT NULL DEFAULT '[]'::jsonb,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    reused BOOLEAN NOT NULL DEFAULT FALSE
  )`,

  `CREATE TABLE IF NOT EXISTS verification_steps (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    required BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL,
    provenance TEXT,
    command JSONB NOT NULL DEFAULT '[]'::jsonb,
    exit_code INTEGER,
    duration_ms INTEGER,
    stdout_preview TEXT,
    stderr_preview TEXT,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    log_artifact_id UUID,
    counts JSONB,
    timed_out BOOLEAN NOT NULL DEFAULT FALSE
  )`,

  `CREATE TABLE IF NOT EXISTS verification_artifacts (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    iteration INTEGER,
    kind TEXT NOT NULL,
    type TEXT,
    path TEXT,
    size BIGINT,
    sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS verification_runs_project_idx ON verification_runs (project_id, iteration)`,
  `CREATE INDEX IF NOT EXISTS verification_steps_run_idx ON verification_steps (run_id)`,
  `CREATE INDEX IF NOT EXISTS verification_artifacts_project_idx ON verification_artifacts (project_id, iteration)`
];

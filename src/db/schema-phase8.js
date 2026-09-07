export const PHASE8_MIGRATION_ID = '006_phase8_security';

export const PHASE8_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS project_security_policies (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    profile TEXT NOT NULL,
    required_sandbox_mode TEXT NOT NULL,
    network_policy TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS sandbox_runs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL DEFAULT 0,
    backend TEXT NOT NULL,
    mode TEXT NOT NULL,
    image_digest TEXT,
    policy JSONB,
    network_policy TEXT,
    resource_limits JSONB,
    isolation_capabilities JSONB,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS sandbox_events (
    id UUID PRIMARY KEY,
    sandbox_run_id UUID REFERENCES sandbox_runs(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS secret_references (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    secret_ref TEXT NOT NULL UNIQUE,
    class TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS secret_leases (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    secret_ref TEXT NOT NULL,
    class TEXT NOT NULL,
    operation TEXT,
    lease_id TEXT,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS security_findings (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    severity TEXT,
    code TEXT,
    message TEXT,
    blocking BOOLEAN NOT NULL DEFAULT TRUE,
    payload JSONB,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS security_events (
    id UUID PRIMARY KEY,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS owner_tokens (
    id UUID PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked BOOLEAN NOT NULL DEFAULT FALSE
  )`,

  `CREATE TABLE IF NOT EXISTS owner_sessions (
    id UUID PRIMARY KEY,
    token_id UUID REFERENCES owner_tokens(id) ON DELETE CASCADE,
    csrf_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS temporary_project_resources (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL DEFAULT 0,
    resource_type TEXT NOT NULL,
    database_type TEXT,
    connection_secret_ref TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    destroyed_at TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS sandbox_runs_project_idx ON sandbox_runs (project_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS security_events_project_idx ON security_events (project_id, at)`,
  `CREATE INDEX IF NOT EXISTS secret_leases_project_idx ON secret_leases (project_id, issued_at)`
];

export const PHASE7_MIGRATION_ID = '005_phase7_provisioning';

export const PHASE7_STATEMENTS = [
  `ALTER TABLE project_repositories ADD COLUMN IF NOT EXISTS provisioning_baseline_sha TEXT`,

  `CREATE TABLE IF NOT EXISTS project_components (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    component_id TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '.',
    profile JSONB,
    provisioner TEXT,
    template_id TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    verification_policy JSONB,
    runtime_policy JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, component_id)
  )`,

  `CREATE TABLE IF NOT EXISTS provisioning_plans (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_hash TEXT NOT NULL,
    provisioner TEXT NOT NULL,
    template_id TEXT,
    support_status TEXT,
    profile JSONB,
    identity JSONB,
    generator JSONB,
    capabilities_required JSONB NOT NULL DEFAULT '[]'::jsonb,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, plan_hash)
  )`,

  `CREATE TABLE IF NOT EXISTS provisioning_runs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_hash TEXT,
    provisioner TEXT,
    template_id TEXT,
    status TEXT NOT NULL,
    support_status TEXT,
    baseline_sha TEXT,
    generator JSONB,
    toolchain_versions JSONB,
    created_files JSONB NOT NULL DEFAULT '[]'::jsonb,
    blocking_failures JSONB NOT NULL DEFAULT '[]'::jsonb,
    starter_verification JSONB,
    evidence JSONB,
    reused BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS provisioning_steps (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES provisioning_runs(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    required BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL,
    command JSONB NOT NULL DEFAULT '[]'::jsonb,
    exit_code INTEGER,
    duration_ms INTEGER,
    stdout_preview TEXT,
    stderr_preview TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS provisioning_runs_project_idx ON provisioning_runs (project_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS provisioning_plans_project_idx ON provisioning_plans (project_id)`,
  `CREATE INDEX IF NOT EXISTS project_components_project_idx ON project_components (project_id)`
];

export const PHASE6_MIGRATION_ID = '004_phase6_runtime_visual';

export const PHASE6_STATEMENTS = [
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb`,

  `CREATE TABLE IF NOT EXISTS runtime_verification_runs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL,
    checkpoint_sha TEXT,
    artifact_hash TEXT,
    adapter TEXT,
    application_kind TEXT,
    status TEXT NOT NULL,
    plan JSONB,
    policy JSONB,
    launch JSONB,
    diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
    blocking_failures JSONB NOT NULL DEFAULT '[]'::jsonb,
    problems JSONB NOT NULL DEFAULT '[]'::jsonb,
    reused BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS runtime_scenarios (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runtime_verification_runs(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scenario_id TEXT NOT NULL,
    goal TEXT,
    priority TEXT,
    status TEXT NOT NULL,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    assertions JSONB NOT NULL DEFAULT '[]'::jsonb,
    failures JSONB NOT NULL DEFAULT '[]'::jsonb,
    artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
    duration_ms INTEGER,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS runtime_steps (
    id UUID PRIMARY KEY,
    scenario_row_id UUID NOT NULL REFERENCES runtime_scenarios(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    detail JSONB,
    duration_ms INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS screenshots (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    runtime_run_id UUID REFERENCES runtime_verification_runs(id) ON DELETE SET NULL,
    iteration INTEGER,
    scenario_id TEXT,
    step TEXT,
    platform TEXT,
    browser TEXT,
    device TEXT,
    viewport TEXT,
    width INTEGER,
    height INTEGER,
    route TEXT,
    path TEXT,
    sha256 TEXT,
    checkpoint_sha TEXT,
    artifact_hash TEXT,
    baseline_kind TEXT,
    masks JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS accessibility_findings (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    runtime_run_id UUID REFERENCES runtime_verification_runs(id) ON DELETE SET NULL,
    scenario_id TEXT,
    severity TEXT NOT NULL,
    category TEXT,
    code TEXT,
    description TEXT,
    blocking BOOLEAN NOT NULL DEFAULT FALSE,
    provenance TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS visual_review_runs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    runtime_run_id UUID REFERENCES runtime_verification_runs(id) ON DELETE SET NULL,
    iteration INTEGER NOT NULL,
    screenshot_set_hash TEXT,
    checkpoint_sha TEXT,
    status TEXT NOT NULL,
    decision TEXT,
    reviewers JSONB NOT NULL DEFAULT '[]'::jsonb,
    chair JSONB,
    blocking_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
    usage JSONB,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS visual_findings (
    id UUID PRIMARY KEY,
    review_run_id UUID NOT NULL REFERENCES visual_review_runs(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    reviewer TEXT,
    screen TEXT,
    device TEXT,
    severity TEXT NOT NULL,
    category TEXT,
    description TEXT,
    evidence TEXT,
    region JSONB,
    required_fix TEXT,
    provenance TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS worker_capabilities (
    worker_id TEXT PRIMARY KEY,
    os TEXT,
    arch TEXT,
    capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS runtime_runs_project_idx ON runtime_verification_runs (project_id, iteration)`,
  `CREATE INDEX IF NOT EXISTS runtime_scenarios_run_idx ON runtime_scenarios (run_id)`,
  `CREATE INDEX IF NOT EXISTS screenshots_project_idx ON screenshots (project_id, iteration)`,
  `CREATE INDEX IF NOT EXISTS accessibility_project_idx ON accessibility_findings (project_id)`,
  `CREATE INDEX IF NOT EXISTS visual_runs_project_idx ON visual_review_runs (project_id, iteration)`,
  `CREATE INDEX IF NOT EXISTS visual_findings_run_idx ON visual_findings (review_run_id)`,
  `CREATE INDEX IF NOT EXISTS jobs_capabilities_idx ON jobs USING GIN (required_capabilities)`
];

export const PHASE4_MIGRATION_ID = '002_phase4_cursor';

export const PHASE4_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS project_repositories (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    repository_type TEXT NOT NULL,
    repository_source TEXT,
    canonical_path TEXT,
    owner_path TEXT,
    remote_url TEXT,
    cloud_repository_url TEXT,
    remote_provider TEXT,
    base_ref TEXT,
    baseline_sha TEXT,
    working_branch TEXT,
    workspace_path TEXT,
    owner_working_tree_dirty BOOLEAN NOT NULL DEFAULT FALSE,
    cursor_backend TEXT,
    lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE',
    cleanup_status TEXT,
    session_map JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS project_repositories_workspace_idx
    ON project_repositories (workspace_path)`
];

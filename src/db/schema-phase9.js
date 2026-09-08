export const PHASE9_MIGRATION_ID = '007_phase9_delivery';

export const PHASE9_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS delivery_snapshots (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    checkpoint_sha TEXT NOT NULL,
    provisioning_baseline_sha TEXT,
    verification_set_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    current BOOLEAN NOT NULL DEFAULT FALSE,
    manifest JSONB,
    manifest_hash TEXT,
    owner_report TEXT,
    verification_report TEXT,
    known_limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
    release_notes TEXT,
    lineage JSONB,
    secret_scan TEXT,
    retention JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ready_at TIMESTAMPTZ,
    UNIQUE (project_id, version)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS delivery_one_current
    ON delivery_snapshots (project_id) WHERE current`,

  `CREATE TABLE IF NOT EXISTS delivery_artifacts (
    id UUID PRIMARY KEY,
    delivery_id UUID NOT NULL REFERENCES delivery_snapshots(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT,
    size BIGINT,
    sha256 TEXT NOT NULL,
    checkpoint_sha TEXT,
    verification_run_id TEXT,
    stored_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS owner_reviews (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    delivery_id UUID NOT NULL REFERENCES delivery_snapshots(id) ON DELETE CASCADE,
    decision TEXT NOT NULL,
    feedback TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (delivery_id)
  )`,

  `CREATE TABLE IF NOT EXISTS owner_notifications (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    delivery_id UUID REFERENCES delivery_snapshots(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS notification_deliveries (
    id UUID PRIMARY KEY,
    notification_id UUID REFERENCES owner_notifications(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS review_sessions (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    delivery_id UUID NOT NULL REFERENCES delivery_snapshots(id) ON DELETE CASCADE,
    artifact_hash TEXT,
    checkpoint_sha TEXT,
    backend TEXT,
    review_url TEXT,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    stopped_at TIMESTAMPTZ,
    runtime JSONB
  )`,

  `CREATE INDEX IF NOT EXISTS delivery_snapshots_project_idx ON delivery_snapshots (project_id, version)`,
  `CREATE INDEX IF NOT EXISTS owner_notifications_project_idx ON owner_notifications (project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS review_sessions_project_idx ON review_sessions (project_id, started_at)`
];

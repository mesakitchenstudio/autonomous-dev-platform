import { jsonValue, toIso } from '../storage/project-document.js';

export async function persistPhase9(tx, project) {
  if (shouldSkipPhase9Persist(project)) return;
  if (project.deliveries?.length) {
    await tx.query('UPDATE delivery_snapshots SET current = FALSE WHERE project_id = $1', [project.id]);
  }
  for (const delivery of project.deliveries || []) {
    const existing = await tx.query(
      `SELECT id FROM delivery_snapshots WHERE project_id = $1 AND (id = $2 OR version = $3 OR idempotency_key = $4) LIMIT 1`,
      [project.id, delivery.id, delivery.version, delivery.idempotencyKey]
    );
    if (existing.rows[0]) delivery.id = existing.rows[0].id;
    await tx.query(`INSERT INTO delivery_snapshots (
      id, project_id, version, checkpoint_sha, provisioning_baseline_sha, verification_set_hash,
      idempotency_key, status, current, manifest, manifest_hash, owner_report, verification_report,
      known_limitations, release_notes, lineage, secret_scan, retention, created_at, ready_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      current = EXCLUDED.current,
      manifest = EXCLUDED.manifest,
      manifest_hash = EXCLUDED.manifest_hash,
      owner_report = EXCLUDED.owner_report,
      verification_report = EXCLUDED.verification_report,
      known_limitations = EXCLUDED.known_limitations,
      release_notes = EXCLUDED.release_notes,
      lineage = EXCLUDED.lineage,
      secret_scan = EXCLUDED.secret_scan,
      ready_at = EXCLUDED.ready_at
    WHERE delivery_snapshots.status IS DISTINCT FROM EXCLUDED.status
      OR delivery_snapshots.current IS DISTINCT FROM EXCLUDED.current
      OR delivery_snapshots.manifest_hash IS DISTINCT FROM EXCLUDED.manifest_hash`, [
      delivery.id, project.id, delivery.version, delivery.checkpointSha,
      delivery.provisioningBaselineSha || null, delivery.verificationSetHash,
      delivery.idempotencyKey, delivery.status, Boolean(delivery.current),
      jsonb(delivery.manifest || null), delivery.manifestHash || null,
      delivery.ownerReport || null, delivery.verificationReport || null,
      jsonb(delivery.knownLimitations || []), delivery.releaseNotes || null,
      jsonb(delivery.lineage || null), delivery.secretScan || null,
      jsonb(delivery.retention || null), delivery.createdAt || new Date().toISOString(),
      delivery.readyAt || null
    ]);
    for (const artifact of delivery.artifacts || []) {
      if (!artifact.id) continue;
      await tx.query(`INSERT INTO delivery_artifacts (
        id, delivery_id, project_id, kind, file_name, mime_type, size, sha256, checkpoint_sha,
        verification_run_id, stored_path, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (id) DO UPDATE SET sha256 = EXCLUDED.sha256, stored_path = EXCLUDED.stored_path`, [
        artifact.id, delivery.id, project.id, artifact.kind, artifact.fileName,
        artifact.mimeType || null, artifact.size || null, artifact.sha256,
        artifact.checkpointSha || null, artifact.verificationRunId || null, artifact.storedPath || null
      ]);
    }
  }
  for (const review of project.ownerReviews || []) {
    await tx.query(`INSERT INTO owner_reviews (id, project_id, delivery_id, decision, feedback, created_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (delivery_id) DO NOTHING`, [
      review.id, project.id, review.deliveryId, review.decision, review.feedback || null, review.createdAt
    ]);
  }
  for (const item of project.notifications || []) {
    await tx.query(`INSERT INTO owner_notifications (
      id, project_id, delivery_id, type, title, body, read_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET read_at = EXCLUDED.read_at`, [
      item.id, project.id, item.deliveryId || null, item.type, item.title, item.body,
      item.readAt || null, item.createdAt
    ]);
  }
  for (const item of project.notificationDeliveries || []) {
    await tx.query(`INSERT INTO notification_deliveries (
      id, notification_id, project_id, provider, idempotency_key, status, payload, created_at, sent_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (idempotency_key) DO UPDATE SET status = EXCLUDED.status, sent_at = EXCLUDED.sent_at`, [
      item.id, item.notificationId || null, project.id, item.provider, item.idempotencyKey,
      item.status, jsonb(item.payload || null), item.createdAt || new Date().toISOString(), item.sentAt || null
    ]);
  }
  for (const session of project.reviewSessions || []) {
    await tx.query(`INSERT INTO review_sessions (
      id, project_id, delivery_id, artifact_hash, checkpoint_sha, backend, review_url, status,
      started_at, expires_at, stopped_at, runtime
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status, stopped_at = EXCLUDED.stopped_at, review_url = EXCLUDED.review_url`, [
      session.id, project.id, session.deliveryId, session.artifactHash || null, session.checkpointSha || null,
      session.backend || null, session.reviewUrl || null, session.status, session.startedAt,
      session.expiresAt, session.stoppedAt || null, jsonb(session.runtime || null)
    ]);
  }
}

export async function hydratePhase9(adapter, assembled) {
  const id = assembled.id;
  const deliveries = await adapter.query('SELECT * FROM delivery_snapshots WHERE project_id = $1 ORDER BY version', [id]).catch(() => ({ rows: [] }));
  const artifacts = await adapter.query('SELECT * FROM delivery_artifacts WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
  const reviews = await adapter.query('SELECT * FROM owner_reviews WHERE project_id = $1 ORDER BY created_at', [id]).catch(() => ({ rows: [] }));
  const notes = await adapter.query('SELECT * FROM owner_notifications WHERE project_id = $1 ORDER BY created_at', [id]).catch(() => ({ rows: [] }));
  const sent = await adapter.query('SELECT * FROM notification_deliveries WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
  const sessions = await adapter.query('SELECT * FROM review_sessions WHERE project_id = $1 ORDER BY started_at', [id]).catch(() => ({ rows: [] }));
  assembled.deliveries = deliveries.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    version: Number(row.version),
    checkpointSha: row.checkpoint_sha,
    provisioningBaselineSha: row.provisioning_baseline_sha,
    verificationSetHash: row.verification_set_hash,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    current: Boolean(row.current),
    manifest: jsonValue(row.manifest, null),
    manifestHash: row.manifest_hash,
    ownerReport: row.owner_report,
    verificationReport: row.verification_report,
    knownLimitations: jsonValue(row.known_limitations, []),
    releaseNotes: row.release_notes,
    lineage: jsonValue(row.lineage, null),
    secretScan: row.secret_scan,
    retention: jsonValue(row.retention, null),
    artifacts: artifacts.rows.filter(item => item.delivery_id === row.id).map(fromArtifactRow),
    screenshots: artifacts.rows.filter(item => item.delivery_id === row.id && item.kind === 'SCREENSHOT').map(fromArtifactRow),
    verification: jsonValue(row.manifest, null)?.verificationSummary || null,
    technicalLimitations: jsonValue(row.manifest, null)?.technicalLimitations || [],
    createdAt: toIso(row.created_at),
    readyAt: toIso(row.ready_at)
  }));
  assembled.deliveryArtifacts = artifacts.rows.map(fromArtifactRow);
  assembled.ownerReviews = reviews.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    deliveryId: row.delivery_id,
    decision: row.decision,
    feedback: row.feedback,
    createdAt: toIso(row.created_at)
  }));
  assembled.notifications = notes.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    deliveryId: row.delivery_id,
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: toIso(row.read_at),
    createdAt: toIso(row.created_at)
  }));
  assembled.notificationDeliveries = sent.rows.map(row => ({
    id: row.id,
    notificationId: row.notification_id,
    projectId: row.project_id,
    provider: row.provider,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    payload: jsonValue(row.payload, null),
    createdAt: toIso(row.created_at),
    sentAt: toIso(row.sent_at)
  }));
  assembled.reviewSessions = sessions.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    deliveryId: row.delivery_id,
    artifactHash: row.artifact_hash,
    checkpointSha: row.checkpoint_sha,
    backend: row.backend,
    reviewUrl: row.review_url,
    status: row.status,
    startedAt: toIso(row.started_at),
    expiresAt: toIso(row.expires_at),
    stoppedAt: toIso(row.stopped_at),
    runtime: jsonValue(row.runtime, null)
  }));
  return assembled;
}

function fromArtifactRow(row) {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    projectId: row.project_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.size == null ? null : Number(row.size),
    sha256: row.sha256,
    checkpointSha: row.checkpoint_sha,
    verificationRunId: row.verification_run_id,
    storedPath: row.stored_path,
    path: row.stored_path
  };
}

function shouldSkipPhase9Persist(project) {
  const implementation = [
    'CURSOR_EXECUTING',
    'PLATFORM_VERIFICATION',
    'RUNTIME_VERIFICATION',
    'VISUAL_VERIFICATION',
    'COUNCIL_REVIEW',
    'PROJECT_PROVISIONING'
  ].includes(project.state);
  if (!implementation) return false;
  const deliveries = project.deliveries || [];
  if (!deliveries.length) return true;
  return deliveries.every(item => item.status !== 'PREPARING');
}

function jsonb(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

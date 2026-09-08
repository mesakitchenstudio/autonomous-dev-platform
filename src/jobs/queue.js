import crypto from 'node:crypto';
import { JobStatus, plannedJob } from './types.js';
import { classifyJobError, retryDelayMs } from './classify.js';
import { jsonValue, toIso } from '../storage/project-document.js';
import { intEnv } from '../util/env.js';

export class JobQueue {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.maxAttempts = options.maxAttempts ?? intEnv('JOB_MAX_ATTEMPTS', 8);
    this.leaseMs = options.leaseMs ?? intEnv('JOB_LEASE_MS', 900000);
    this.retryBaseMs = options.retryBaseMs ?? intEnv('JOB_RETRY_BASE_MS', 2000);
    this.retryMaxMs = options.retryMaxMs ?? intEnv('JOB_RETRY_MAX_MS', 60000);
  }

  async enqueue(project, extras = {}) {
    const planned = extras.jobType ? {
      jobType: extras.jobType,
      phase: extras.phase || extras.jobType,
      iteration: extras.iteration ?? project.iteration ?? 0,
      idempotencyKey: extras.idempotencyKey,
      requiredCapabilities: extras.requiredCapabilities || []
    } : plannedJob(project);
    if (!planned) return null;
    const id = extras.id || crypto.randomUUID();
    const existing = await this.adapter.query(
      `SELECT * FROM jobs WHERE idempotency_key = $1 AND status IN ('QUEUED', 'RUNNING')`,
      [planned.idempotencyKey]
    );
    if (existing.rows[0]) return fromJobRow(existing.rows[0]);
    try {
      const result = await this.adapter.query(`INSERT INTO jobs (
        id, project_id, job_type, phase, iteration, idempotency_key, payload, status, priority,
        attempts, max_attempts, available_at, required_capabilities
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'QUEUED',$8,0,$9,COALESCE($10::timestamptz, NOW()),$11::jsonb)
      RETURNING *`, [
        id, project.id, planned.jobType, planned.phase, planned.iteration, planned.idempotencyKey,
        JSON.stringify(extras.payload || {}), extras.priority ?? 100, extras.maxAttempts ?? this.maxAttempts,
        extras.availableAt || null,
        JSON.stringify(planned.requiredCapabilities || extras.requiredCapabilities || [])
      ]);
      return result.rows[0] ? fromJobRow(result.rows[0]) : null;
    } catch (error) {
      if (!/jobs_active_idempotency|duplicate key/i.test(error.message || '')) throw error;
      return this.findActiveByKey(planned.idempotencyKey);
    }
  }

  async findActiveByKey(idempotencyKey) {
    const result = await this.adapter.query(
      `SELECT * FROM jobs WHERE idempotency_key = $1 AND status IN ('QUEUED', 'RUNNING')`,
      [idempotencyKey]
    );
    return result.rows[0] ? fromJobRow(result.rows[0]) : null;
  }

  async findByKey(idempotencyKey) {
    const result = await this.adapter.query('SELECT * FROM jobs WHERE idempotency_key = $1', [idempotencyKey]);
    return result.rows[0] ? fromJobRow(result.rows[0]) : null;
  }

  async claim(workerId, capabilities = []) {
    const leaseExpires = new Date(Date.now() + this.leaseMs).toISOString();
    const caps = JSON.stringify(capabilities || []);
    return this.adapter.transact(async tx => {
      const found = await tx.query(`SELECT id FROM jobs
        WHERE status = 'QUEUED' AND available_at <= NOW()
        AND (
          COALESCE(required_capabilities, '[]'::jsonb) = '[]'::jsonb
          OR $1::jsonb @> COALESCE(required_capabilities, '[]'::jsonb)
        )
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`, [caps]);
      const id = found.rows[0]?.id;
      if (!id) return null;
      const current = await tx.query('SELECT * FROM jobs WHERE id = $1', [id]);
      if (!current.rows[0] || current.rows[0].status !== JobStatus.QUEUED) return null;
      const updated = await tx.query(`UPDATE jobs SET
        status = 'RUNNING',
        locked_by = $2,
        lease_expires_at = $3,
        heartbeat_at = NOW(),
        started_at = COALESCE(started_at, NOW()),
        attempts = attempts + 1
        WHERE id = $1
        RETURNING *`, [id, workerId, leaseExpires]);
      return fromJobRow(updated.rows[0]);
    });
  }

  async heartbeat(jobId, workerId) {
    const leaseExpires = new Date(Date.now() + this.leaseMs).toISOString();
    const result = await this.adapter.query(`UPDATE jobs SET
      heartbeat_at = NOW(),
      lease_expires_at = $3
      WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING'
      RETURNING *`, [jobId, workerId, leaseExpires]);
    return result.rows[0] ? fromJobRow(result.rows[0]) : null;
  }

  async owns(jobId, workerId) {
    const result = await this.adapter.query(
      `SELECT 1 FROM jobs WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING' AND lease_expires_at > NOW()`,
      [jobId, workerId]
    );
    return result.rows.length > 0;
  }

  async completeAndHandoff(job, project, enqueueNext = true) {
    return this.adapter.transact(async tx => {
      await tx.query(`UPDATE jobs SET
        status = 'COMPLETED', locked_by = NULL, lease_expires_at = NULL,
        completed_at = NOW(), last_error = NULL
        WHERE id = $1`, [job.id]);
      if (!enqueueNext) return { next: null };
      const planned = plannedJob(project);
      if (!planned) return { next: null };
      const existing = await tx.query(
        `SELECT * FROM jobs WHERE idempotency_key = $1 AND status IN ('QUEUED', 'RUNNING')`,
        [planned.idempotencyKey]
      );
      if (existing.rows[0]) return { next: fromJobRow(existing.rows[0]) };
      try {
        const inserted = await tx.query(`INSERT INTO jobs (
          id, project_id, job_type, phase, iteration, idempotency_key, payload, status, priority,
          attempts, max_attempts, available_at, required_capabilities
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'QUEUED',100,0,$8,NOW(),$9::jsonb)
        RETURNING *`, [
          crypto.randomUUID(), project.id, planned.jobType, planned.phase, planned.iteration,
          planned.idempotencyKey, JSON.stringify({}), this.maxAttempts,
          JSON.stringify(planned.requiredCapabilities || [])
        ]);
        return { next: inserted.rows[0] ? fromJobRow(inserted.rows[0]) : null };
      } catch (error) {
        if (!/duplicate key|unique/i.test(error.message || '')) throw error;
        const existingKey = await tx.query(
          `SELECT * FROM jobs WHERE idempotency_key = $1 ORDER BY created_at DESC LIMIT 1`,
          [planned.idempotencyKey]
        );
        return { next: existingKey.rows[0] ? fromJobRow(existingKey.rows[0]) : null };
      }
    });
  }

  async fail(job, error, { terminal = false } = {}) {
    const classified = classifyJobError(error);
    const attempts = job.attempts || 0;
    const exhausted = terminal || !classified.retryable || attempts >= (job.maxAttempts || this.maxAttempts);
    if (exhausted) {
      const updated = await this.adapter.query(`UPDATE jobs SET
        status = 'DEAD', locked_by = NULL, lease_expires_at = NULL, failed_at = NOW(), last_error = $2
        WHERE id = $1 RETURNING *`, [job.id, JSON.stringify(errorRecord(error, classified))]);
      return { job: fromJobRow(updated.rows[0]), dead: true, retryable: false };
    }
    const delay = retryDelayMs(attempts, this.retryBaseMs, this.retryMaxMs);
    const availableAt = new Date(Date.now() + delay).toISOString();
    const updated = await this.adapter.query(`UPDATE jobs SET
      status = 'QUEUED', locked_by = NULL, lease_expires_at = NULL, available_at = $2, last_error = $3
      WHERE id = $1 RETURNING *`, [job.id, availableAt, JSON.stringify(errorRecord(error, classified))]);
    return { job: fromJobRow(updated.rows[0]), dead: false, retryable: true, availableAt, delayMs: delay };
  }

  async recoverExpiredLeases(exceptIds = []) {
    const recovered = exceptIds.length
      ? await this.adapter.query(`UPDATE jobs SET
          status = 'QUEUED',
          locked_by = NULL,
          lease_expires_at = NULL,
          available_at = NOW()
          WHERE status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= NOW()
          AND NOT (id = ANY($1::uuid[]))
          RETURNING *`, [exceptIds])
      : await this.adapter.query(`UPDATE jobs SET
          status = 'QUEUED',
          locked_by = NULL,
          lease_expires_at = NULL,
          available_at = NOW()
          WHERE status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= NOW()
          RETURNING *`);
    return recovered.rows.map(fromJobRow);
  }

  async release(jobId, workerId) {
    await this.adapter.query(`UPDATE jobs SET
      status = 'QUEUED', locked_by = NULL, lease_expires_at = NULL, available_at = NOW()
      WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING'`, [jobId, workerId]);
  }

  async counts() {
    const result = await this.adapter.query(`SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status`);
    const counts = { queued: 0, running: 0, failed: 0, completed: 0, dead: 0 };
    for (const row of result.rows) {
      if (row.status === 'QUEUED') counts.queued = row.count;
      if (row.status === 'RUNNING') counts.running = row.count;
      if (row.status === 'FAILED') counts.failed = row.count;
      if (row.status === 'COMPLETED') counts.completed = row.count;
      if (row.status === 'DEAD') counts.dead = row.count;
    }
    counts.failed += counts.dead;
    return counts;
  }

  async reconcile(projects) {
    const resumed = [];
    for (const project of projects) {
      const planned = plannedJob(project);
      if (!planned) continue;
      const existing = await this.adapter.query(
        `SELECT id, status FROM jobs WHERE project_id = $1 AND status IN ('QUEUED', 'RUNNING')`,
        [project.id]
      );
      if (existing.rows.length) continue;
      const job = await this.enqueue(project);
      if (job && job.status === JobStatus.QUEUED) resumed.push(project.id);
    }
    return resumed;
  }
}

function errorRecord(error, classified) {
  return {
    code: classified.code,
    message: error?.message || String(error),
    retryable: classified.retryable,
    at: new Date().toISOString()
  };
}

export function fromJobRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    jobType: row.job_type,
    phase: row.phase,
    iteration: Number(row.iteration || 0),
    idempotencyKey: row.idempotency_key,
    payload: jsonValue(row.payload, {}),
    status: row.status,
    priority: row.priority,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 8),
    availableAt: toIso(row.available_at),
    lockedBy: row.locked_by,
    leaseExpiresAt: toIso(row.lease_expires_at),
    heartbeatAt: toIso(row.heartbeat_at),
    createdAt: toIso(row.created_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    failedAt: toIso(row.failed_at),
    lastError: jsonValue(row.last_error, null),
    requiredCapabilities: jsonValue(row.required_capabilities, [])
  };
}

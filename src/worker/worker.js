import { createWorkerId } from './identity.js';
import { JobType } from '../jobs/types.js';
import { ErrorCode, PlatformError, toErrorRecord } from '../orchestrator/errors.js';
import { ProjectState } from '../orchestrator/states.js';
import { intEnv } from '../util/env.js';
import { discoverWorkerCapabilities } from '../capabilities/discover.js';
import { persistWorkerCapabilities } from '../capabilities/registry.js';

export class Worker {
  constructor({ store, queue, orchestrator, pollMs, heartbeatMs, concurrency } = {}) {
    this.store = store;
    this.queue = queue;
    this.orchestrator = orchestrator;
    this.pollMs = pollMs ?? intEnv('WORKER_POLL_MS', 400);
    this.heartbeatMs = heartbeatMs ?? intEnv('JOB_HEARTBEAT_MS', 30000);
    this.concurrency = concurrency ?? intEnv('WORKER_CONCURRENCY', 1);
    this.workerId = createWorkerId();
    this.capabilities = [];
    this.stopping = false;
    this.ticking = false;
    this.active = new Map();
    this.timer = null;
  }

  async start() {
    this.stopping = false;
    const discovered = await discoverWorkerCapabilities();
    this.capabilities = discovered.capabilities || [];
    await persistWorkerCapabilities(this.store?.adapter, this.workerId, discovered);
    await this.tick();
    this.timer = setInterval(() => this.tick().catch(error => {
      console.error('Worker tick failed:', error.message);
    }), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  async tick() {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
    const recovered = await this.queue.recoverExpiredLeases();
    for (const job of recovered) {
      await this.store.appendEvent(job.projectId, 'recovery.performed', {
        jobId: job.id,
        jobType: job.jobType,
        reason: 'lease_expired'
      }).catch(() => {});
    }
    while (!this.stopping && this.active.size < this.concurrency) {
      const job = await this.queue.claim(this.workerId, this.capabilities);
      if (!job) break;
      this.active.set(job.id, this.executeClaimed(job));
    }
    } finally {
      this.ticking = false;
    }
  }

  async executeClaimed(job) {
    const heartbeat = setInterval(() => {
      this.queue.heartbeat(job.id, this.workerId).then(owned => {
        if (!owned) {
          console.error(`Worker ${this.workerId} lost lease for job ${job.id}`);
          this.orchestrator.cursor?.cancel?.('lease_lost');
          this.orchestrator.cancelVerification?.('lease_lost');
        }
      }).catch(error => {
        console.error(`Heartbeat failed for job ${job.id}: ${error.message}`);
      });
    }, this.heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();
    try {
      await this.store.appendEvent(job.projectId, eventForStart(job.jobType), { jobId: job.id, iteration: job.iteration });
      if (job.jobType === JobType.CURSOR_EXECUTION || job.jobType === JobType.PROJECT_PROVISIONING || job.jobType === JobType.PLATFORM_VERIFICATION || job.jobType === JobType.RUNTIME_VERIFICATION || job.jobType === JobType.VISUAL_VERIFICATION) {
        const ready = await this.store.adapter.ready().catch(() => false);
        if (!ready) {
          throw new PlatformError({
            code: 'DATABASE_UNAVAILABLE',
            message: 'Database is unavailable; Cursor/verification was not started.',
            phase: ProjectState.CURSOR_EXECUTING,
            retryable: true
          });
        }
      }
      await this.orchestrator.executeJob(job, {
        owns: () => this.queue.owns(job.id, this.workerId),
        dbReady: () => this.store.adapter.ready().then(() => true).catch(() => false)
      });
      const project = await this.store.get(job.projectId);
      await this.queue.completeAndHandoff(job, project);
      await this.store.appendEvent(job.projectId, eventForComplete(job.jobType, project), {
        jobId: job.id,
        state: project.state,
        iteration: project.iteration
      });
    } catch (error) {
      const record = toErrorRecord(error, job.phase);
      const result = await this.queue.fail(job, record, { terminal: record.retryable === false });
      if (result.dead) {
        await this.orchestrator.fail(job.projectId, error).catch(() => {});
        await this.store.appendEvent(job.projectId, 'project.failed', { jobId: job.id, code: record.code });
      } else {
        await this.store.appendEvent(job.projectId, 'job.retry_scheduled', {
          jobId: job.id,
          code: record.code,
          availableAt: result.availableAt
        });
      }
    } finally {
      clearInterval(heartbeat);
      this.active.delete(job.id);
    }
  }

  async stop({ timeoutMs = 20000 } = {}) {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    const started = Date.now();
    while (this.active.size && Date.now() - started < timeoutMs) {
      await Promise.race([
        Promise.allSettled([...this.active.values()]),
        new Promise(resolve => setTimeout(resolve, 100))
      ]);
    }
    for (const jobId of this.active.keys()) {
      await this.queue.release(jobId, this.workerId).catch(() => {});
    }
    this.active.clear();
  }
}

function eventForStart(jobType) {
  if (jobType === JobType.COUNCIL_DISCOVERY) return 'council.started';
  if (jobType === JobType.PROJECT_PROVISIONING) return 'provisioning.started';
  if (jobType === JobType.CURSOR_EXECUTION) return 'cursor.started';
  if (jobType === JobType.PLATFORM_VERIFICATION) return 'verification.started';
  if (jobType === JobType.RUNTIME_VERIFICATION) return 'runtime.started';
  if (jobType === JobType.VISUAL_VERIFICATION) return 'visual.started';
  if (jobType === JobType.COUNCIL_REVIEW) return 'review.started';
  if (jobType === JobType.FINAL_VERIFICATION) return 'final.started';
  return 'job.started';
}

function eventForComplete(jobType, project) {
  if (jobType === JobType.COUNCIL_DISCOVERY) return 'chair.completed';
  if (jobType === JobType.PROJECT_PROVISIONING) return 'provisioning.completed';
  if (jobType === JobType.CURSOR_EXECUTION) return 'cursor.completed';
  if (jobType === JobType.PLATFORM_VERIFICATION) return 'verification.completed';
  if (jobType === JobType.RUNTIME_VERIFICATION) return 'runtime.completed';
  if (jobType === JobType.VISUAL_VERIFICATION) return 'visual.completed';
  if (project.state === ProjectState.CURSOR_EXECUTING) return 'correction.requested';
  if (project.state === ProjectState.READY_FOR_OWNER_REVIEW) return 'project.ready';
  return 'job.completed';
}

export { ErrorCode };

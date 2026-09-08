import { ProjectState, assertTransition, isBootResumable, isOwnerTerminal } from './states.js';
import { ErrorCode, PlatformError, toErrorRecord } from './errors.js';
import { withTimeout } from './timeout.js';
import { canCompleteAutonomousWork, canEnterOwnerReview, hasValidSpec, latestCursorRun, specProductName } from './gate.js';
import { prepareDeliverySnapshot, ownerDeliveryView } from '../delivery/prepare.js';
import { currentDelivery } from '../delivery/lineage.js';
import { recordOwnerDecision, withProjectLock } from '../delivery/decisions.js';
import { NotificationService } from '../notifications/index.js';
import { OwnerDecision } from '../delivery/kinds.js';
import { SecurityEventType } from '../security/kinds.js';
import { recordSecurityEvent } from '../security/events.js';
import { evidenceFromCursorResult, EvidenceStatus } from './evidence.js';
import { beginOperation, completeOperation, failOperation, currentOperation, OperationType, OperationStatus } from './checkpoint.js';
import { intEnv } from '../util/env.js';
import { JobType } from '../jobs/types.js';
import { cursorPreflight } from '../cursor/preflight.js';
import { cursorPostflight } from '../cursor/postflight.js';
import { slimCursorReviewInput, resolveCursorBackend, CursorMode, CursorRunStatus, CursorUncertainty } from '../cursor/contract.js';
import { defaultCursorMode } from '../cursor/index.js';
import { inspectGit } from '../git/inspect.js';
import { isGitRepository } from '../git/worktree.js';
import {
  runPlatformVerification,
  latestVerificationRun,
  slimVerificationReviewInput,
  findReusableVerification,
  correctionPromptFromVerification,
  evidenceFromVerification
} from '../verify/pipeline.js';
import { cancelActiveVerification } from '../verify/runner.js';
import {
  runRuntimeVerification,
  latestRuntimeRun,
  slimRuntimeReviewInput,
  findReusableRuntime,
  correctionPromptFromRuntime,
  shouldSkipRuntime,
  cancelActiveRuntime
} from '../runtime/pipeline.js';
import {
  runVisualVerification,
  latestVisualRun,
  slimVisualReviewInput,
  findReusableVisual,
  correctionPromptFromVisual,
  shouldSkipVisual
} from '../visual/pipeline.js';
import {
  needsProvisioning,
  provisioningSucceeded,
  createProvisioningPlan
} from '../provision/plan.js';
import { runProjectProvisioning, applyProvisioningResult } from '../provision/pipeline.js';
import { resolveUnsupportedArchitecture } from '../provision/architecture.js';
import crypto from 'node:crypto';

export class Orchestrator {
  constructor({ store, council, cursor, workspace, maxIterations = 12, demo = false, cursorTimeoutMs, queue } = {}) {
    this.store = store;
    this.council = council;
    this.cursor = cursor;
    this.workspace = workspace;
    this.maxIterations = maxIterations;
    this.demo = demo;
    this.cursorTimeoutMs = cursorTimeoutMs ?? intEnv('CURSOR_REQUEST_TIMEOUT_MS', 600000);
    this.queue = queue || null;
    this.running = new Set();
    this.notifications = new NotificationService();
  }

  cancelVerification(reason = 'cancelled') {
    cancelActiveRuntime(reason);
    return cancelActiveVerification(reason);
  }

  async transition(project, to, note, details = {}) {
    assertTransition(project.state, to);
    project.history = project.history || [];
    project.history.push({
      at: new Date().toISOString(),
      from: project.state,
      to,
      note,
      details
    });
    project.state = to;
    await this.store.save(project);
    return project;
  }

  start(id) {
    if (this.running.has(id)) return false;
    this.running.add(id);
    setImmediate(() => this.run(id).finally(() => this.running.delete(id)));
    return true;
  }

  async recoverOnBoot() {
    const projects = await this.store.list();
    for (const project of projects) {
      if (project.state === ProjectState.DELIVERY_PREPARATION) {
        try {
          await this.finishDelivery(project);
        } catch (error) {
          project.error = toErrorRecord(error, ProjectState.DELIVERY_PREPARATION);
          await this.store.save(project).catch(() => {});
        }
      }
    }
    if (this.queue) return this.queue.reconcile((await this.store.list()).filter(project => isBootResumable(project.state)));
    const resumed = [];
    for (const project of projects) {
      if (isBootResumable(project.state) && this.start(project.id)) resumed.push(project.id);
    }
    return resumed;
  }

  async submit({ idea, projectPath }) {
    const project = await this.store.create({ idea, projectPath, demo: this.demo });
    if (this.queue) {
      await this.queue.enqueue(project);
      return project;
    }
    this.start(project.id);
    return project;
  }

  async retry(id) {
    const project = await this.store.get(id);
    if (project.state !== ProjectState.FAILED) {
      throw new PlatformError({
        code: ErrorCode.RETRY_NOT_ELIGIBLE,
        message: `Retry is only valid from FAILED (current state: ${project.state})`,
        phase: project.state,
        retryable: false
      });
    }
    project.errors = project.errors || [];
    project.error = null;
    const target = resumeTargetAfterFailure(project);
    await this.transition(project, target, 'Explicit retry from safest checkpoint', { resumeTarget: target });
    if (this.queue) {
      await this.queue.enqueue(await this.store.get(id));
      return this.store.get(id);
    }
    this.start(id);
    return project;
  }

  async executeJob(job, ctx = {}) {
    this.executionContext = ctx;
    const project = await this.store.get(job.projectId);
    if (isOwnerTerminal(project.state) || project.state === ProjectState.FAILED) return project;
    if (job.jobType === JobType.COUNCIL_DISCOVERY) {
      if (project.state === ProjectState.SPECIFICATION_READY || project.state === ProjectState.PROJECT_PROVISIONING) return project;
      if (project.state === ProjectState.OWNER_CHANGES_REQUESTED) {
        await this.transition(project, ProjectState.COUNCIL_DISCOVERY, 'Interpreting owner feedback');
      }
      await this.ensureDiscovery(await this.store.get(job.projectId));
      return this.store.get(job.projectId);
    }
    if (job.jobType === JobType.PROJECT_PROVISIONING) {
      if ([ProjectState.CURSOR_EXECUTING, ProjectState.PLATFORM_VERIFICATION, ProjectState.RUNTIME_VERIFICATION, ProjectState.VISUAL_VERIFICATION, ProjectState.COUNCIL_REVIEW, ProjectState.FINAL_VERIFICATION, ProjectState.DELIVERY_PREPARATION].includes(project.state) || isOwnerTerminal(project.state)) return project;
      if (project.state === ProjectState.SPECIFICATION_READY || project.state === ProjectState.PROJECT_PROVISIONING) {
        await this.finishProvisioning(await this.store.get(job.projectId), ctx);
      }
      return this.store.get(job.projectId);
    }
    if (job.jobType === JobType.CURSOR_EXECUTION) {
      if ([ProjectState.PLATFORM_VERIFICATION, ProjectState.RUNTIME_VERIFICATION, ProjectState.VISUAL_VERIFICATION, ProjectState.COUNCIL_REVIEW, ProjectState.FINAL_VERIFICATION, ProjectState.DELIVERY_PREPARATION].includes(project.state)) return project;
      if (project.state === ProjectState.SPECIFICATION_READY) {
        if (needsProvisioning(project) && !provisioningSucceeded(project)) {
          await this.finishProvisioning(project, ctx);
          return this.store.get(job.projectId);
        }
        await this.requestCursorRun(project, { increment: true, ctx });
      } else if (project.state === ProjectState.PROJECT_PROVISIONING) {
        await this.finishProvisioning(project, ctx);
      } else if (project.state === ProjectState.CURSOR_EXECUTING) await this.finishOrReplayCursor(project, ctx);
      return this.store.get(job.projectId);
    }
    if (job.jobType === JobType.PLATFORM_VERIFICATION) {
      if ([ProjectState.RUNTIME_VERIFICATION, ProjectState.VISUAL_VERIFICATION, ProjectState.COUNCIL_REVIEW, ProjectState.FINAL_VERIFICATION, ProjectState.DELIVERY_PREPARATION].includes(project.state) || isOwnerTerminal(project.state)) return project;
      if (project.state === ProjectState.CURSOR_EXECUTING) await this.finishOrReplayCursor(project, ctx);
      if ((await this.store.get(job.projectId)).state === ProjectState.PLATFORM_VERIFICATION) {
        await this.finishPlatformVerification(await this.store.get(job.projectId), ctx);
      }
      return this.store.get(job.projectId);
    }
    if (job.jobType === JobType.RUNTIME_VERIFICATION) {
      if ([ProjectState.VISUAL_VERIFICATION, ProjectState.COUNCIL_REVIEW, ProjectState.FINAL_VERIFICATION, ProjectState.DELIVERY_PREPARATION].includes(project.state) || isOwnerTerminal(project.state)) return project;
      if (project.state === ProjectState.PLATFORM_VERIFICATION) await this.finishPlatformVerification(await this.store.get(job.projectId), ctx);
      if ((await this.store.get(job.projectId)).state === ProjectState.RUNTIME_VERIFICATION) {
        await this.finishRuntimeVerification(await this.store.get(job.projectId), ctx);
      }
      return this.store.get(job.projectId);
    }
    if (job.jobType === JobType.VISUAL_VERIFICATION) {
      if ([ProjectState.COUNCIL_REVIEW, ProjectState.FINAL_VERIFICATION, ProjectState.DELIVERY_PREPARATION].includes(project.state) || isOwnerTerminal(project.state)) return project;
      if (project.state === ProjectState.RUNTIME_VERIFICATION) await this.finishRuntimeVerification(await this.store.get(job.projectId), ctx);
      if ((await this.store.get(job.projectId)).state === ProjectState.VISUAL_VERIFICATION) {
        await this.finishVisualVerification(await this.store.get(job.projectId), ctx);
      }
      return this.store.get(job.projectId);
    }
    if (job.jobType === JobType.COUNCIL_REVIEW) {
      if ([ProjectState.FINAL_VERIFICATION, ProjectState.DELIVERY_PREPARATION, ProjectState.CURSOR_EXECUTING, ProjectState.PLATFORM_VERIFICATION, ProjectState.RUNTIME_VERIFICATION, ProjectState.VISUAL_VERIFICATION].includes(project.state)) return project;
      await this.finishReview(project);
      return this.store.get(job.projectId);
    }
    if (job.jobType === JobType.FINAL_VERIFICATION) {
      if (isOwnerTerminal(project.state) || project.state === ProjectState.CURSOR_EXECUTING) return project;
      if (project.state === ProjectState.DELIVERY_PREPARATION) {
        await this.finishDelivery(project);
        return this.store.get(job.projectId);
      }
      await this.finishFinal(project);
      return this.store.get(job.projectId);
    }
    if (job.jobType === JobType.DELIVERY_PREPARATION) {
      if (isOwnerTerminal(project.state)) return project;
      if (project.state === ProjectState.FINAL_VERIFICATION) await this.finishFinal(project);
      if ((await this.store.get(job.projectId)).state === ProjectState.DELIVERY_PREPARATION) {
        await this.finishDelivery(await this.store.get(job.projectId));
      }
      return this.store.get(job.projectId);
    }
    throw new PlatformError({
      code: ErrorCode.RECOVERY_FAILED,
      message: `Unknown job type ${job.jobType}`,
      phase: project.state,
      retryable: false
    });
  }

  async run(id) {
    let project = await this.store.get(id);
    try {
      if (isOwnerTerminal(project.state) || project.state === ProjectState.FAILED) return;
      while (true) {
        project = await this.store.get(id);
        if (isOwnerTerminal(project.state) || project.state === ProjectState.FAILED) return;
        if (project.iteration > this.maxIterations) {
          throw new PlatformError({
            code: ErrorCode.MAX_ITERATIONS_REACHED,
            message: `Maximum implementation iterations (${this.maxIterations}) reached before completion.`,
            phase: project.state,
            retryable: false,
            details: { iteration: project.iteration, maxIterations: this.maxIterations }
          });
        }
        if (project.state === ProjectState.IDEA_SUBMITTED || project.state === ProjectState.COUNCIL_DISCOVERY) {
          await this.ensureDiscovery(project);
          continue;
        }
        if (project.state === ProjectState.SPECIFICATION_READY) {
          if (needsProvisioning(project) && !provisioningSucceeded(project)) {
            await this.enterProvisioning(project, this.executionContext);
            continue;
          }
          await this.requestCursorRun(project, { increment: true, ctx: this.executionContext });
          continue;
        }
        if (project.state === ProjectState.PROJECT_PROVISIONING) {
          await this.finishProvisioning(project, this.executionContext);
          continue;
        }
        if (project.state === ProjectState.CURSOR_EXECUTING) {
          await this.finishOrReplayCursor(project, this.executionContext);
          continue;
        }
        if (project.state === ProjectState.PLATFORM_VERIFICATION) {
          await this.finishPlatformVerification(project, this.executionContext);
          continue;
        }
        if (project.state === ProjectState.RUNTIME_VERIFICATION) {
          await this.finishRuntimeVerification(project, this.executionContext);
          continue;
        }
        if (project.state === ProjectState.VISUAL_VERIFICATION) {
          await this.finishVisualVerification(project, this.executionContext);
          continue;
        }
        if (project.state === ProjectState.COUNCIL_REVIEW) {
          await this.finishReview(project);
          continue;
        }
        if (project.state === ProjectState.FINAL_VERIFICATION) {
          await this.finishFinal(project);
          continue;
        }
        if (project.state === ProjectState.DELIVERY_PREPARATION) {
          await this.finishDelivery(project);
          continue;
        }
        if (project.state === ProjectState.OWNER_CHANGES_REQUESTED) {
          await this.transition(project, ProjectState.COUNCIL_DISCOVERY, 'Interpreting owner feedback');
          continue;
        }
        throw new PlatformError({
          code: ErrorCode.RECOVERY_FAILED,
          message: `No recovery handler for state ${project.state}`,
          phase: project.state,
          retryable: false
        });
      }
    } catch (error) {
      await this.fail(id, error);
    }
  }

  async fail(id, error) {
    const project = await this.store.get(id);
    const record = toErrorRecord(error, project.state);
    project.error = record;
    project.errors = project.errors || [];
    project.errors.push(record);
    const op = currentOperation(project);
    if (project.checkpoint?.status === OperationStatus.STARTED) failOperation(project, op, record);
    if (project.state !== ProjectState.FAILED && !isOwnerTerminal(project.state)) {
      await this.transition(project, ProjectState.FAILED, record.message, { code: record.code });
    } else {
      await this.store.save(project);
    }
  }

  async ensureDiscovery(project) {
    if (project.state === ProjectState.IDEA_SUBMITTED) {
      await this.transition(project, ProjectState.COUNCIL_DISCOVERY, 'Council analyzing product idea');
    }
    if (hasValidSpec(project)) {
      if (project.pendingOwnerFeedback) {
        await this.applyOwnerFeedback(project);
      }
      if (project.state === ProjectState.COUNCIL_DISCOVERY) {
        await this.transition(project, ProjectState.SPECIFICATION_READY, project.ownerReviews?.length
          ? 'Owner feedback interpreted; continuing autonomous work'
          : 'Recovered completed specification', {
          productName: specProductName(project.council.discovery.spec)
        });
      }
      return;
    }
    const op = beginOperation(project, OperationType.DISCOVERY);
    await this.store.save(project);
    try {
      const discovery = await this.council.discover(
        project.idea,
        project.projectPath ? `Existing project path: ${project.projectPath}` : 'No existing repository supplied.'
      );
      project.council.discovery = discovery;
      if (!hasValidSpec(project)) {
        throw new PlatformError({
          code: ErrorCode.CHAIR_FAILURE,
          message: 'Council Chair did not produce a valid specification.',
          phase: ProjectState.COUNCIL_DISCOVERY,
          retryable: true
        });
      }
      project.activePrompt = discovery.spec.cursorPrompt;
      if (needsProvisioning(project) && !project.provisioningPlan) {
        const architecture = await resolveUnsupportedArchitecture(project, this.council, { demo: project.demo || this.demo });
        project.provisioningPlan = createProvisioningPlan(project, {
          profile: architecture.profile,
          provisioner: architecture.provisioner
        });
      }
      completeOperation(project, op);
      await this.transition(project, ProjectState.SPECIFICATION_READY, 'Council Chair produced authoritative specification', {
        productName: specProductName(discovery.spec)
      });
    } catch (error) {
      failOperation(project, op, toErrorRecord(error, ProjectState.COUNCIL_DISCOVERY));
      await this.store.save(project);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: error?.code === ErrorCode.ALL_PROVIDERS_FAILED ? ErrorCode.ALL_PROVIDERS_FAILED : ErrorCode.CHAIR_FAILURE,
        message: error.message,
        phase: ProjectState.COUNCIL_DISCOVERY,
        retryable: true
      });
    }
  }

  async enterProvisioning(project, ctx) {
    if (project.state !== ProjectState.PROJECT_PROVISIONING) {
      await this.transition(project, ProjectState.PROJECT_PROVISIONING, 'Provisioning new project foundation');
    }
    if (this.queue) return project;
    return this.finishProvisioning(project, ctx || this.executionContext);
  }

  async finishProvisioning(project, ctx = {}) {
    if (provisioningSucceeded(project)) {
      if (project.state === ProjectState.PROJECT_PROVISIONING || project.state === ProjectState.SPECIFICATION_READY) {
        if (this.queue) {
          if (project.state !== ProjectState.CURSOR_EXECUTING) {
            await this.transition(project, ProjectState.CURSOR_EXECUTING, 'Provisioning recovered; starting implementation');
          }
          return project;
        }
        return this.requestCursorRun(project, { increment: true, execute: !this.queue, ctx });
      }
      return project;
    }
    if (project.state === ProjectState.SPECIFICATION_READY) {
      await this.transition(project, ProjectState.PROJECT_PROVISIONING, 'Provisioning new project foundation');
    }
    const op = beginOperation(project, OperationType.PROJECT_PROVISIONING);
    await this.store.save(project);
    try {
      if (!project.provisioningPlan) {
        const architecture = await resolveUnsupportedArchitecture(project, this.council, { demo: project.demo || this.demo });
        project.provisioningPlan = createProvisioningPlan(project, {
          profile: architecture.profile,
          provisioner: architecture.provisioner
        });
      }
      const run = await runProjectProvisioning({
        project,
        workspace: this.workspace,
        council: this.council,
        demo: project.demo || this.demo,
        owns: ctx.owns,
        dbReady: ctx.dbReady
      });
      applyProvisioningResult(project, run);
      completeOperation(project, op);
      await this.store.save(project);
      if (this.queue) {
        await this.transition(project, ProjectState.CURSOR_EXECUTING, 'Foundation provisioned; starting Cursor implementation');
        return project;
      }
      return this.requestCursorRun(project, { increment: true, execute: true, ctx });
    } catch (error) {
      failOperation(project, op, toErrorRecord(error, ProjectState.PROJECT_PROVISIONING));
      await this.store.save(project);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: error?.code || ErrorCode.PROVISIONING_FAILED,
        message: error.message,
        phase: ProjectState.PROJECT_PROVISIONING,
        retryable: error.retryable !== false
      });
    }
  }

  async requestCursorRun(project, { increment, prompt, execute = true, ctx } = {}) {
    if (needsProvisioning(project) && !provisioningSucceeded(project)) {
      throw new PlatformError({
        code: ErrorCode.PROVISIONING_FAILED,
        message: 'New project cannot reach Cursor before provisioning succeeds.',
        phase: project.state,
        retryable: true
      });
    }
    if (increment) {
      if (project.iteration >= this.maxIterations) {
        throw new PlatformError({
          code: ErrorCode.MAX_ITERATIONS_REACHED,
          message: `Maximum implementation iterations (${this.maxIterations}) reached before completion.`,
          phase: project.state,
          retryable: false,
          details: { iteration: project.iteration, maxIterations: this.maxIterations }
        });
      }
      project.iteration += 1;
    }
    if (prompt) project.activePrompt = prompt;
    project.activePrompt = project.activePrompt || project.council?.discovery?.spec?.cursorPrompt;
    if (project.state !== ProjectState.CURSOR_EXECUTING) {
      await this.transition(project, ProjectState.CURSOR_EXECUTING, `Cursor implementation run ${project.iteration}`);
    } else {
      await this.store.save(project);
    }
    if (!execute) return project;
    await this.executeCursor(project, ctx || this.executionContext);
    await this.enterPlatformVerification(project, ctx);
  }

  async finishOrReplayCursor(project, ctx) {
    const last = latestCursorRun(project);
    if (last && last.iteration === project.iteration && last.result) {
      await this.enterPlatformVerification(project, ctx);
      return;
    }
    if (!project.iteration) project.iteration = 1;
    await this.prepareInterruptedCursor(project, last);
    const recovered = latestCursorRun(project);
    if (recovered && recovered.iteration === project.iteration && recovered.result && recovered.status === CursorRunStatus.COMPLETED) {
      await this.enterPlatformVerification(project, ctx);
      return;
    }
    await this.executeCursor(project, ctx || this.executionContext);
    await this.enterPlatformVerification(project, ctx);
  }

  async enterPlatformVerification(project, ctx) {
    if (project.state !== ProjectState.PLATFORM_VERIFICATION) {
      await this.transition(project, ProjectState.PLATFORM_VERIFICATION, `Platform verifying Cursor run ${project.iteration}`);
    }
    if (this.queue) return project;
    return this.finishPlatformVerification(project, ctx || this.executionContext);
  }

  async finishPlatformVerification(project, ctx = {}) {
    const reused = findReusableVerification(project);
    if (reused) {
      const patch = reused.evidencePatch || evidenceFromVerification(project, reused);
      project.evidence = patch || project.evidence;
      const last = latestCursorRun(project);
      if (last && project.evidence) last.evidence = project.evidence;
      if ((reused.evidencePatch || project.evidence)?.verificationLevel !== 'MOCK') {
        project.verificationLevel = reused.evidencePatch?.verificationLevel || project.verificationLevel;
      }
      await this.store.save(project);
      await this.afterPlatformVerification(project, reused, ctx);
      return;
    }
    const existing = latestVerificationRun(project, project.iteration);
    if (existing?.completedAt && existing.checkpointSha === (latestCursorRun(project)?.checkpointSha || existing.checkpointSha)) {
      const last = latestCursorRun(project);
      if (last && (existing.evidencePatch || project.evidence)) last.evidence = existing.evidencePatch || project.evidence;
      await this.afterPlatformVerification(project, existing, ctx);
      return;
    }
    const op = beginOperation(project, OperationType.PLATFORM_VERIFICATION, { iteration: project.iteration });
    await this.store.save(project);
    try {
      const workspacePath = project.repository?.workspacePath
        || (this.workspace ? await this.workspace.ensure(project) : null)
        || project.projectPath;
      const run = await runPlatformVerification({
        project,
        workspacePath,
        demo: project.demo || this.demo,
        owns: ctx.owns,
        dbReady: ctx.dbReady
      });
      project.verificationRuns = [...(project.verificationRuns || []).filter(item => item.id !== run.id), run];
      if (run.sandboxMode) {
        project.sandboxProvenance = {
          sandboxMode: run.sandboxMode,
          sandboxBackend: run.sandboxBackend,
          isolationCapabilities: run.isolationCapabilities,
          hardened: run.sandboxMode === 'CONTAINER_HARDENED',
          unsafe: run.sandboxMode === 'LOCAL_DEVELOPMENT_UNSAFE'
        };
        project.sandboxRuns = [...(project.sandboxRuns || []), {
          sandboxRunId: run.sandboxRunId || run.id,
          iteration: run.iteration,
          backend: run.sandboxBackend,
          mode: run.sandboxMode,
          isolationCapabilities: run.isolationCapabilities,
          policy: run.sandboxPolicy,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt
        }];
      }
      if (run.evidencePatch) {
        project.evidence = run.evidencePatch;
        const last = latestCursorRun(project);
        if (last) last.evidence = run.evidencePatch;
        if (!run.mock && run.evidencePatch.verificationLevel !== 'MOCK') {
          project.verificationLevel = run.evidencePatch.verificationLevel;
        }
      }
      completeOperation(project, op);
      await this.store.save(project);
      await this.afterPlatformVerification(project, run, ctx);
    } catch (error) {
      failOperation(project, op, toErrorRecord(error, ProjectState.PLATFORM_VERIFICATION));
      await this.store.save(project);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: ErrorCode.VERIFICATION_FAILED,
        message: error.message,
        phase: ProjectState.PLATFORM_VERIFICATION,
        retryable: true
      });
    }
  }

  async afterPlatformVerification(project, verification, ctx) {
    if (shouldSkipRuntime(project, verification)) {
      await this.transition(project, ProjectState.COUNCIL_REVIEW, `Council reviewing verified Cursor run ${project.iteration}`);
      return;
    }
    return this.enterRuntimeVerification(project, ctx);
  }

  async enterRuntimeVerification(project, ctx) {
    if (project.state !== ProjectState.RUNTIME_VERIFICATION) {
      await this.transition(project, ProjectState.RUNTIME_VERIFICATION, `Runtime verifying Cursor run ${project.iteration}`);
    }
    if (this.queue) return project;
    return this.finishRuntimeVerification(project, ctx || this.executionContext);
  }

  async finishRuntimeVerification(project, ctx = {}) {
    const reused = findReusableRuntime(project);
    if (reused) {
      project.evidence = reused.evidencePatch || project.evidence;
      project.runtimeRuns = [...(project.runtimeRuns || []).filter(item => item.id !== reused.id), reused];
      await this.store.save(project);
      return this.afterRuntimeVerification(project, reused, ctx);
    }
    const existing = latestRuntimeRun(project, project.iteration);
    if (existing?.completedAt && existing.checkpointSha === (latestCursorRun(project)?.checkpointSha || existing.checkpointSha)) {
      return this.afterRuntimeVerification(project, existing, ctx);
    }
    const op = beginOperation(project, OperationType.RUNTIME_VERIFICATION, { iteration: project.iteration });
    await this.store.save(project);
    try {
      const workspacePath = project.repository?.workspacePath
        || (this.workspace ? await this.workspace.ensure(project) : null)
        || project.projectPath;
      const run = await runRuntimeVerification({
        project,
        workspacePath,
        demo: project.demo || this.demo,
        owns: ctx.owns,
        dbReady: ctx.dbReady
      });
      project.runtimeRuns = [...(project.runtimeRuns || []).filter(item => item.id !== run.id), run];
      project.runtimePlan = run.plan || project.runtimePlan;
      if (run.evidencePatch) {
        project.evidence = run.evidencePatch;
        const last = latestCursorRun(project);
        if (last) last.evidence = run.evidencePatch;
      }
      completeOperation(project, op);
      await this.store.save(project);
      return this.afterRuntimeVerification(project, run, ctx);
    } catch (error) {
      failOperation(project, op, toErrorRecord(error, ProjectState.RUNTIME_VERIFICATION));
      await this.store.save(project);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: ErrorCode.RUNTIME_CRASH,
        message: error.message,
        phase: ProjectState.RUNTIME_VERIFICATION,
        retryable: true
      });
    }
  }

  async afterRuntimeVerification(project, runtime, ctx) {
    if (runtime?.blockingFailures?.length || shouldSkipVisual(project, runtime)) {
      await this.transition(project, ProjectState.COUNCIL_REVIEW, `Council reviewing runtime evidence ${project.iteration}`);
      return;
    }
    return this.enterVisualVerification(project, ctx);
  }

  async enterVisualVerification(project, ctx) {
    if (project.state !== ProjectState.VISUAL_VERIFICATION) {
      await this.transition(project, ProjectState.VISUAL_VERIFICATION, `Visually reviewing Cursor run ${project.iteration}`);
    }
    if (this.queue) return project;
    return this.finishVisualVerification(project, ctx || this.executionContext);
  }

  async finishVisualVerification(project, ctx = {}) {
    const reused = findReusableVisual(project);
    if (reused) {
      project.evidence = reused.evidencePatch || project.evidence;
      project.visualReviewRuns = [...(project.visualReviewRuns || []).filter(item => item.id !== reused.id), reused];
      await this.store.save(project);
      await this.transition(project, ProjectState.COUNCIL_REVIEW, `Council reviewing visual evidence ${project.iteration}`);
      return;
    }
    const existing = latestVisualRun(project, project.iteration);
    if (existing?.completedAt && existing.checkpointSha === (latestCursorRun(project)?.checkpointSha || existing.checkpointSha)) {
      await this.transition(project, ProjectState.COUNCIL_REVIEW, `Recovered completed visual verification ${project.iteration}`);
      return;
    }
    const op = beginOperation(project, OperationType.VISUAL_VERIFICATION, { iteration: project.iteration });
    await this.store.save(project);
    try {
      const run = await runVisualVerification({
        project,
        council: this.council,
        demo: project.demo || this.demo,
        owns: ctx.owns,
        dbReady: ctx.dbReady
      });
      project.visualReviewRuns = [...(project.visualReviewRuns || []).filter(item => item.id !== run.id), run];
      if (run.evidencePatch) {
        project.evidence = run.evidencePatch;
        const last = latestCursorRun(project);
        if (last) last.evidence = run.evidencePatch;
      }
      completeOperation(project, op);
      await this.store.save(project);
      await this.transition(project, ProjectState.COUNCIL_REVIEW, `Council reviewing runtime and visual evidence ${project.iteration}`);
    } catch (error) {
      failOperation(project, op, toErrorRecord(error, ProjectState.VISUAL_VERIFICATION));
      await this.store.save(project);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: ErrorCode.VISUAL_REVIEW_FAILED,
        message: error.message,
        phase: ProjectState.VISUAL_VERIFICATION,
        retryable: true
      });
    }
  }

  async prepareInterruptedCursor(project, last) {
    const cwd = project.repository?.workspacePath;
    if (!cwd || !last || last.result) return;
    if (!(await isGitRepository(cwd))) return;
    const snapshot = inspectGit(cwd);
    if (last.checkpointSha && last.checkpointSha === snapshot.sha && !snapshot.dirty) {
      last.status = CursorRunStatus.COMPLETED;
      last.result = last.result || { recoveredFromCheckpoint: true, git: { checkpointSha: last.checkpointSha } };
      await this.store.save(project);
      return;
    }
    if (snapshot.dirty) {
      last.status = CursorRunStatus.RECOVERY_REQUIRED;
      last.uncertainty = CursorUncertainty.UNCOMMITTED_CHANGES;
      project.activePrompt = [
        'A previous Cursor iteration was interrupted. Inspect the current autonomous branch and any uncommitted changes.',
        'Do not discard, reset, or clean those changes.',
        'Complete the original task from the current repository state.',
        '',
        project.activePrompt || ''
      ].join('\n');
      await this.store.save(project);
    }
  }

  async executeCursor(project, ctx = {}) {
    const op = beginOperation(project, OperationType.CURSOR, { prompt: project.activePrompt });
    let started = (project.cursorRuns || []).find(item => item.iteration === project.iteration && !item.result);
    if (!started) {
      started = {
        id: crypto.randomUUID(),
        iteration: project.iteration,
        attempt: 1,
        status: CursorRunStatus.STARTED,
        at: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        prompt: project.activePrompt
      };
      project.cursorRuns.push(started);
    } else {
      started.status = CursorRunStatus.STARTED;
      started.attempt = (started.attempt || 1) + (started.status === CursorRunStatus.FAILED ? 1 : 0);
    }
    await this.store.save(project);
    try {
      const localPath = this.workspace
        ? await this.workspace.ensure(project)
        : (project.repository?.workspacePath || project.projectPath || process.env.CURSOR_PROJECT_PATH || process.cwd());
      project.repository = project.repository || {};
      const backend = resolveCursorBackend(project, this.demo ? CursorMode.MOCK : defaultCursorMode());
      if (!project.repository.cursorBackend) project.repository.cursorBackend = backend;
      await cursorPreflight({
        project,
        workspacePath: localPath,
        demo: project.demo || this.demo,
        owns: ctx.owns,
        dbReady: ctx.dbReady,
        timeoutMs: this.cursorTimeoutMs,
        backend
      });
      const sessionId = project.repository.acpSessionId || project.repository.cloudAgentId || started.sessionId || null;
      const resumePoll = Boolean(started.agentId && started.cloudRunId && started.status === CursorRunStatus.STARTED);
      const raw = await withTimeout(
        this.cursor.run({
          cwd: localPath,
          prompt: project.activePrompt,
          sessionId,
          agentId: project.repository.cloudAgentId || started.agentId || null,
          runId: project.repository.cloudRunId || started.cloudRunId || null,
          resumePoll,
          projectId: project.id,
          cursorRunId: started.id,
          iteration: project.iteration,
          workspace: project.repository,
          acceptanceCriteria: project.council?.discovery?.spec?.acceptanceCriteria || [],
          shouldContinue: ctx.owns,
          onSession: async (id, extra = {}) => {
            project.repository.acpSessionId = id;
            if (extra.agentId || extra.runId) {
              project.repository.cloudAgentId = extra.agentId || id;
              project.repository.cloudRunId = extra.runId || project.repository.cloudRunId;
            }
            project.repository.sessionMap = [...(project.repository.sessionMap || []), {
              iteration: project.iteration,
              sessionId: id,
              agentId: extra.agentId || null,
              runId: extra.runId || null,
              restarted: Boolean(extra.restarted)
            }];
            started.sessionId = id;
            started.agentId = extra.agentId || started.agentId;
            started.cloudRunId = extra.runId || started.cloudRunId;
            started.executionMode = backend;
            await this.store.save(project);
          }
        }),
        this.cursorTimeoutMs,
        { code: ErrorCode.CURSOR_TIMEOUT, message: `Cursor execution timed out after ${this.cursorTimeoutMs}ms`, phase: ProjectState.CURSOR_EXECUTING }
      );
      const post = await cursorPostflight({
        project,
        workspacePath: localPath,
        raw,
        demo: project.demo || this.demo
      });
      const evidence = evidenceFromCursorResult({ ...raw, evidence: post.evidence || raw?.evidence }, { demo: project.demo || this.demo });
      if (post.evidence?.git?.provenance === 'PLATFORM_VERIFIED') {
        evidence.git = post.evidence.git;
        if (evidence.verificationLevel !== 'MOCK') evidence.verificationLevel = 'SELF_REPORTED';
      }
      if (evidence.execution.status === EvidenceStatus.FAIL) {
        throw new PlatformError({
          code: ErrorCode.CURSOR_EXECUTION_FAILED,
          message: 'Cursor execution completed with an execution-level failure.',
          phase: ProjectState.CURSOR_EXECUTING,
          retryable: true,
          details: { stopReason: raw?.stopReason || null }
        });
      }
      const result = { ...raw, evidence, git: post.git, changedFiles: post.changedFiles, checkpointSha: post.checkpointSha };
      Object.assign(started, {
        status: CursorRunStatus.COMPLETED,
        at: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        prompt: project.activePrompt,
        result,
        sessionId: raw?.sessionId || sessionId,
        executionMode: raw?.executionMode || backend,
        evidence,
        git: post.git,
        changedFiles: post.changedFiles,
        checkpointSha: post.checkpointSha,
        uncertainty: post.uncertainty || raw?.uncertainty
      });
      project.evidence = evidence;
      project.verificationLevel = evidence.verificationLevel;
      if (raw?.permissionLog) {
        project.permissionLog = [...(project.permissionLog || []), ...raw.permissionLog];
      }
      completeOperation(project, op);
      await this.store.save(project);
    } catch (error) {
      started.status = started.result ? CursorRunStatus.RECOVERY_REQUIRED : CursorRunStatus.FAILED;
      started.error = toErrorRecord(error, ProjectState.CURSOR_EXECUTING);
      failOperation(project, op, toErrorRecord(error, ProjectState.CURSOR_EXECUTING));
      await this.store.save(project);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: error?.code === ErrorCode.SECRET_FILE_BLOCKED ? ErrorCode.SECRET_FILE_BLOCKED : ErrorCode.CURSOR_EXECUTION_FAILED,
        message: error.message,
        phase: ProjectState.CURSOR_EXECUTING,
        retryable: true
      });
    }
  }

  async finishReview(project) {
    const key = `review${project.iteration}`;
    if (!project.council[key]) {
      const last = latestCursorRun(project);
      if (!last) {
        throw new PlatformError({
          code: ErrorCode.RECOVERY_FAILED,
          message: 'Cannot review without a completed Cursor run.',
          phase: ProjectState.COUNCIL_REVIEW,
          retryable: true
        });
      }
      const op = beginOperation(project, OperationType.REVIEW, { iteration: project.iteration });
      await this.store.save(project);
      try {
        const platformVerification = slimVerificationReviewInput(latestVerificationRun(project, project.iteration));
        const runtimeVerification = slimRuntimeReviewInput(latestRuntimeRun(project, project.iteration));
        const visualVerification = slimVisualReviewInput(latestVisualRun(project, project.iteration));
        const review = await this.council.review({
          idea: project.idea,
          spec: project.council.discovery.spec,
          cursorResult: slimCursorReviewInput(last),
          platformVerification,
          runtimeVerification,
          visualVerification,
          verificationPlan: platformVerification?.policy ? latestVerificationRun(project, project.iteration)?.plan : null,
          iteration: project.iteration
        });
        project.council[key] = review;
        completeOperation(project, op);
        await this.store.save(project);
      } catch (error) {
        failOperation(project, op, toErrorRecord(error, ProjectState.COUNCIL_REVIEW));
        await this.store.save(project);
        if (error instanceof PlatformError) throw error;
        throw new PlatformError({
          code: ErrorCode.CHAIR_FAILURE,
          message: error.message,
          phase: ProjectState.COUNCIL_REVIEW,
          retryable: true
        });
      }
    }
    const review = project.council[key];
    const verification = latestVerificationRun(project, project.iteration);
    const runtime = latestRuntimeRun(project, project.iteration);
    const visual = latestVisualRun(project, project.iteration);
    if (review.decision?.decision === 'COMPLETE' && !project.demo && !this.demo) {
      if (verification?.blockingFailures?.length) {
        review.decision.decision = 'CHANGES_REQUIRED';
        review.decision.nextCursorPrompt = review.decision.nextCursorPrompt || correctionPromptFromVerification(verification);
      } else if (runtime?.blockingFailures?.length) {
        review.decision.decision = 'CHANGES_REQUIRED';
        review.decision.nextCursorPrompt = review.decision.nextCursorPrompt || correctionPromptFromRuntime(runtime);
      } else if (visual?.blockingFindings?.length || visual?.decision === 'CHANGES_REQUIRED') {
        review.decision.decision = 'CHANGES_REQUIRED';
        review.decision.nextCursorPrompt = review.decision.nextCursorPrompt || correctionPromptFromVisual(visual, runtime);
      }
    }
    if (review.decision?.decision === 'CHANGES_REQUIRED') {
      const nextPrompt = review.decision.nextCursorPrompt
        || correctionPromptFromVerification(verification)
        || correctionPromptFromRuntime(runtime)
        || correctionPromptFromVisual(visual, runtime)
        || `Fix all material findings: ${JSON.stringify(review.decision.findings || [])}`;
      await this.requestCursorRun(project, { increment: true, prompt: nextPrompt, execute: !this.queue, ctx: this.executionContext });
      return;
    }
    await this.transition(project, ProjectState.FINAL_VERIFICATION, 'Running adversarial final release verification');
  }

  async finishFinal(project) {
    const cursorCount = project.cursorRuns.length;
    const finalMatches = project.council.final?.cursorCount === cursorCount;
    if (!project.council.final || !finalMatches) {
      const op = beginOperation(project, OperationType.FINAL);
      await this.store.save(project);
      try {
        const runtime = latestRuntimeRun(project);
        const visual = latestVisualRun(project);
        const final = await this.council.finalVerify({
          idea: project.idea,
          spec: project.council.discovery.spec,
          cursorRuns: project.cursorRuns,
          platformVerification: slimVerificationReviewInput(latestVerificationRun(project)),
          verificationRuns: project.verificationRuns || [],
          runtimeVerification: slimRuntimeReviewInput(runtime),
          visualVerification: slimVisualReviewInput(visual),
          accessibility: runtime?.accessibility || [],
          screenshots: (runtime?.screenshots || []).map(item => ({ id: item.id, path: item.path, sha256: item.sha256, viewport: item.viewport, checkpointSha: item.checkpointSha })),
          security: {
            sandboxProvenance: project.sandboxProvenance || latestVerificationRun(project)?.sandboxPolicy || null,
            findings: (project.securityFindings || []).map(item => ({ kind: item.kind, severity: item.severity, code: item.code, blocking: item.blocking })),
            secretScan: (project.secretScanFindings || []).map(item => ({ id: item.id, path: item.path ? String(item.path).split(/[\\/]/).pop() : null, confidence: item.confidence })),
            policy: project.securityPolicy || null
          }
        });
        project.council.final = { ...final, cursorCount };
        completeOperation(project, op);
        await this.store.save(project);
      } catch (error) {
        failOperation(project, op, toErrorRecord(error, ProjectState.FINAL_VERIFICATION));
        await this.store.save(project);
        if (error instanceof PlatformError) throw error;
        throw new PlatformError({
          code: ErrorCode.CHAIR_FAILURE,
          message: error.message,
          phase: ProjectState.FINAL_VERIFICATION,
          retryable: true
        });
      }
    }
    const final = project.council.final;
    if (final.decision?.decision === 'CHANGES_REQUIRED') {
      project.council.finalHistory = project.council.finalHistory || [];
      project.council.finalHistory.push(final);
      project.council.final = null;
      const nextPrompt = final.decision.nextCursorPrompt || `Resolve release blockers: ${JSON.stringify(final.decision.blockingFindings || [])}`;
      await this.requestCursorRun(project, { increment: true, prompt: nextPrompt, execute: !this.queue, ctx: this.executionContext });
      return;
    }
    await this.enterDeliveryPreparation(project);
  }

  async enterDeliveryPreparation(project) {
    const gate = canCompleteAutonomousWork(project, { maxIterations: this.maxIterations });
    if (!gate.ok) {
      throw new PlatformError({
        code: ErrorCode.COMPLETION_GATE_REJECTED,
        message: `Completion gate rejected delivery preparation: ${gate.reasons.join(', ')}`,
        phase: ProjectState.FINAL_VERIFICATION,
        retryable: true,
        details: { reasons: gate.reasons }
      });
    }
    if (project.state !== ProjectState.DELIVERY_PREPARATION) {
      await this.transition(project, ProjectState.DELIVERY_PREPARATION, 'Preparing immutable owner delivery snapshot');
    }
    return this.finishDelivery(project);
  }

  async finishDelivery(project) {
    const workspacePath = await this.workspace?.ensure?.(project).catch(() => project.repository?.workspacePath || project.projectPath);
    const prepared = await prepareDeliverySnapshot(project, { workspacePath });
    const delivery = prepared.delivery;
    const gate = canEnterOwnerReview(project, { maxIterations: this.maxIterations });
    if (!gate.ok) {
      throw new PlatformError({
        code: ErrorCode.COMPLETION_GATE_REJECTED,
        message: `Completion gate rejected READY_FOR_OWNER_REVIEW: ${gate.reasons.join(', ')}`,
        phase: ProjectState.DELIVERY_PREPARATION,
        retryable: true,
        details: { reasons: gate.reasons }
      });
    }
    project.delivery = {
      ...ownerDeliveryView(project),
      status: 'READY_FOR_OWNER_REVIEW',
      productName: specProductName(project.council.discovery.spec),
      summary: project.council.final?.decision?.summary || 'Ready for final owner review.',
      iterations: project.iteration,
      readyAt: delivery.readyAt,
      verificationLevel: gate.verificationLevel,
      gate
    };
    project.verificationLevel = gate.verificationLevel;
    await this.notifications.notifyReady(project, delivery);
    if (project.state !== ProjectState.READY_FOR_OWNER_REVIEW) {
      await this.transition(project, ProjectState.READY_FOR_OWNER_REVIEW, 'Delivery snapshot ready for owner review', {
        verificationLevel: gate.verificationLevel,
        deliveryId: delivery.id,
        deliveryVersion: delivery.version
      });
    } else {
      await this.store.save(project);
    }
    return project;
  }

  async applyOwnerFeedback(project) {
    const pending = project.pendingOwnerFeedback;
    if (!pending) return project;
    const extra = [
      'Owner feedback cycle. Do not restart product discovery from zero.',
      `Original idea: ${project.idea}`,
      `Current specification product: ${specProductName(project.council.discovery.spec)}`,
      `Latest delivery: ${currentDelivery(project)?.id || 'none'}`,
      `Owner feedback: ${pending.feedback}`,
      'Interpret the feedback and determine the minimal coherent changes required.',
      'Preserve architecture unless the feedback itself requires a change.'
    ].join('\n');
    try {
      const result = await this.council.discover(project.idea, extra);
      if (result?.spec?.cursorPrompt) {
        project.council.discovery.spec.cursorPrompt = result.spec.cursorPrompt;
      } else {
        project.council.discovery.spec.cursorPrompt = `${project.council.discovery.spec.cursorPrompt}\n\nOwner feedback: ${pending.feedback}`;
      }
    } catch {
      project.council.discovery.spec.cursorPrompt = `${project.council.discovery.spec.cursorPrompt}\n\nOwner feedback: ${pending.feedback}`;
    }
    project.activePrompt = project.council.discovery.spec.cursorPrompt;
    project.pendingOwnerFeedback = null;
    await this.store.save(project);
    return project;
  }

  async approve(id) {
    return withProjectLock(id, async () => {
      const project = await this.store.get(id);
      if (project.state !== ProjectState.READY_FOR_OWNER_REVIEW) {
        throw new PlatformError({
          code: ErrorCode.OWNER_DECISION_CONFLICT,
          message: `Approve is only valid from READY_FOR_OWNER_REVIEW (current state: ${project.state})`,
          phase: project.state,
          retryable: false
        });
      }
      const delivery = currentDelivery(project);
      const review = recordOwnerDecision(project, { delivery, decision: OwnerDecision.APPROVED });
      recordSecurityEvent(SecurityEventType.OWNER_APPROVED, { deliveryId: delivery.id, reviewId: review.id }, { store: this.store });
      await this.transition(project, ProjectState.OWNER_APPROVED, 'Owner accepted this autonomous-development result', {
        deliveryId: delivery.id,
        reviewId: review.id
      });
      await this.transition(await this.store.get(id), ProjectState.DONE, 'Project completed', {
        deliveryId: delivery.id,
        reviewId: review.id
      });
      return this.store.get(id);
    });
  }

  async requestChanges(id, feedback) {
    return withProjectLock(id, async () => {
      const project = await this.store.get(id);
      if (project.state !== ProjectState.READY_FOR_OWNER_REVIEW) {
        throw new PlatformError({
          code: ErrorCode.OWNER_DECISION_CONFLICT,
          message: `Request Changes is only valid from READY_FOR_OWNER_REVIEW (current state: ${project.state})`,
          phase: project.state,
          retryable: false
        });
      }
      const delivery = currentDelivery(project);
      const review = recordOwnerDecision(project, { delivery, decision: OwnerDecision.CHANGES_REQUESTED, feedback });
      recordSecurityEvent(SecurityEventType.OWNER_CHANGES_REQUESTED, { deliveryId: delivery.id, reviewId: review.id }, { store: this.store });
      await this.transition(project, ProjectState.OWNER_CHANGES_REQUESTED, 'Owner requested changes', {
        deliveryId: delivery.id,
        reviewId: review.id
      });
      await this.transition(await this.store.get(id), ProjectState.COUNCIL_DISCOVERY, 'Autonomous correction cycle started from owner feedback');
      const updated = await this.store.get(id);
      if (this.queue) await this.queue.enqueue(updated);
      else this.start(id);
      return updated;
    });
  }
}

export function resumeTargetAfterFailure(project) {
  if (!hasValidSpec(project)) return ProjectState.COUNCIL_DISCOVERY;
  if (needsProvisioning(project) && !provisioningSucceeded(project)) return ProjectState.PROJECT_PROVISIONING;
  const last = latestCursorRun(project);
  const completed = last && (last.result || last.evidence || last.status === 'COMPLETED' || last.checkpointSha) ? last : null;
  const lastFrom = project.history?.at(-1)?.from;
  if (!completed && (project.iteration > 0 || lastFrom === ProjectState.CURSOR_EXECUTING || project.checkpoint?.type === OperationType.CURSOR || last)) {
    return ProjectState.CURSOR_EXECUTING;
  }
  const verification = latestVerificationRun(project, completed?.iteration);
  if (completed && !verification?.completedAt) return ProjectState.PLATFORM_VERIFICATION;
  const runtime = latestRuntimeRun(project, completed?.iteration);
  if (completed && verification?.completedAt && !shouldSkipRuntime(project, verification) && !runtime?.completedAt) {
    return ProjectState.RUNTIME_VERIFICATION;
  }
  if (completed && runtime?.completedAt && !shouldSkipVisual(project, runtime) && !latestVisualRun(project, completed?.iteration)?.completedAt) {
    return ProjectState.VISUAL_VERIFICATION;
  }
  if (completed && !project.council[`review${completed.iteration}`]) return ProjectState.COUNCIL_REVIEW;
  if (completed && project.council[`review${completed.iteration}`]?.decision?.decision === 'COMPLETE' && !project.council.final) {
    return ProjectState.FINAL_VERIFICATION;
  }
  if (completed && project.council.final?.decision?.decision === 'COMPLETE' && !currentDelivery(project)) {
    return ProjectState.DELIVERY_PREPARATION;
  }
  return ProjectState.SPECIFICATION_READY;
}

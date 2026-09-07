import { ProjectState, assertTransition, isBootResumable, isOwnerTerminal } from './states.js';
import { ErrorCode, PlatformError, toErrorRecord } from './errors.js';
import { withTimeout } from './timeout.js';
import { canEnterOwnerReview, hasValidSpec, latestCursorRun } from './gate.js';
import { evidenceFromCursorResult, EvidenceStatus } from './evidence.js';
import { beginOperation, completeOperation, failOperation, currentOperation, OperationType, OperationStatus } from './checkpoint.js';
import { intEnv } from '../util/env.js';

export class Orchestrator {
  constructor({ store, council, cursor, workspace, maxIterations = 12, demo = false, cursorTimeoutMs } = {}) {
    this.store = store;
    this.council = council;
    this.cursor = cursor;
    this.workspace = workspace;
    this.maxIterations = maxIterations;
    this.demo = demo;
    this.cursorTimeoutMs = cursorTimeoutMs ?? intEnv('CURSOR_REQUEST_TIMEOUT_MS', 600000);
    this.running = new Set();
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
    const resumed = [];
    for (const project of projects) {
      if (isBootResumable(project.state) && this.start(project.id)) resumed.push(project.id);
    }
    return resumed;
  }

  async submit({ idea, projectPath }) {
    const project = await this.store.create({ idea, projectPath, demo: this.demo });
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
    this.start(id);
    return project;
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
          await this.requestCursorRun(project, { increment: true });
          continue;
        }
        if (project.state === ProjectState.CURSOR_EXECUTING) {
          await this.finishOrReplayCursor(project);
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
      if (project.state === ProjectState.COUNCIL_DISCOVERY) {
        await this.transition(project, ProjectState.SPECIFICATION_READY, 'Recovered completed specification', {
          productName: project.council.discovery.spec.productName
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
      completeOperation(project, op);
      await this.transition(project, ProjectState.SPECIFICATION_READY, 'Council Chair produced authoritative specification', {
        productName: discovery.spec.productName
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

  async requestCursorRun(project, { increment, prompt } = {}) {
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
    await this.executeCursor(project);
    await this.transition(project, ProjectState.COUNCIL_REVIEW, `Council reviewing Cursor run ${project.iteration}`);
  }

  async finishOrReplayCursor(project) {
    const last = latestCursorRun(project);
    if (last && last.iteration === project.iteration && last.result) {
      await this.transition(project, ProjectState.COUNCIL_REVIEW, `Recovered completed Cursor run ${project.iteration}`);
      return;
    }
    if (!project.iteration) project.iteration = 1;
    await this.executeCursor(project);
    await this.transition(project, ProjectState.COUNCIL_REVIEW, `Council reviewing Cursor run ${project.iteration}`);
  }

  async executeCursor(project) {
    const op = beginOperation(project, OperationType.CURSOR, { prompt: project.activePrompt });
    await this.store.save(project);
    try {
      const localPath = this.workspace
        ? await this.workspace.ensure(project)
        : (project.projectPath || process.env.CURSOR_PROJECT_PATH || process.cwd());
      if (!project.projectPath && this.workspace) project.projectPath = localPath;
      const sessionId = project.cursorRuns.at(-1)?.sessionId || null;
      const raw = await withTimeout(
        this.cursor.run({ cwd: localPath, prompt: project.activePrompt, sessionId }),
        this.cursorTimeoutMs,
        { code: ErrorCode.CURSOR_TIMEOUT, message: `Cursor execution timed out after ${this.cursorTimeoutMs}ms`, phase: ProjectState.CURSOR_EXECUTING }
      );
      const evidence = evidenceFromCursorResult(raw, { demo: project.demo || this.demo });
      if (evidence.execution.status === EvidenceStatus.FAIL) {
        throw new PlatformError({
          code: ErrorCode.CURSOR_EXECUTION_FAILED,
          message: 'Cursor execution completed with an execution-level failure.',
          phase: ProjectState.CURSOR_EXECUTING,
          retryable: true,
          details: { stopReason: raw?.stopReason || null }
        });
      }
      const result = { ...raw, evidence };
      project.cursorRuns.push({
        iteration: project.iteration,
        at: new Date().toISOString(),
        prompt: project.activePrompt,
        result,
        sessionId: raw?.sessionId || sessionId,
        evidence
      });
      project.evidence = evidence;
      project.verificationLevel = evidence.verificationLevel;
      if (raw?.permissionLog) {
        project.permissionLog = [...(project.permissionLog || []), ...raw.permissionLog];
      }
      completeOperation(project, op);
      await this.store.save(project);
    } catch (error) {
      failOperation(project, op, toErrorRecord(error, ProjectState.CURSOR_EXECUTING));
      await this.store.save(project);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: ErrorCode.CURSOR_EXECUTION_FAILED,
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
        const review = await this.council.review({
          idea: project.idea,
          spec: project.council.discovery.spec,
          cursorResult: last.result,
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
    if (review.decision?.decision === 'CHANGES_REQUIRED') {
      const nextPrompt = review.decision.nextCursorPrompt || `Fix all material findings: ${JSON.stringify(review.decision.findings || [])}`;
      await this.requestCursorRun(project, { increment: true, prompt: nextPrompt });
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
        const final = await this.council.finalVerify({
          idea: project.idea,
          spec: project.council.discovery.spec,
          cursorRuns: project.cursorRuns
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
      await this.requestCursorRun(project, { increment: true, prompt: nextPrompt });
      return;
    }
    await this.enterOwnerReview(project);
  }

  async enterOwnerReview(project) {
    const gate = canEnterOwnerReview(project, { maxIterations: this.maxIterations });
    if (!gate.ok) {
      throw new PlatformError({
        code: ErrorCode.COMPLETION_GATE_REJECTED,
        message: `Completion gate rejected READY_FOR_OWNER_REVIEW: ${gate.reasons.join(', ')}`,
        phase: ProjectState.FINAL_VERIFICATION,
        retryable: true,
        details: { reasons: gate.reasons }
      });
    }
    project.delivery = {
      status: 'READY_FOR_OWNER_REVIEW',
      productName: project.council.discovery.spec.productName,
      summary: project.council.final.decision.summary,
      iterations: project.iteration,
      readyAt: new Date().toISOString(),
      verificationLevel: gate.verificationLevel,
      gate
    };
    project.verificationLevel = gate.verificationLevel;
    await this.transition(project, ProjectState.READY_FOR_OWNER_REVIEW, 'Application passed autonomous development and release review', {
      verificationLevel: gate.verificationLevel
    });
  }
}

export function resumeTargetAfterFailure(project) {
  if (!hasValidSpec(project)) return ProjectState.COUNCIL_DISCOVERY;
  const last = latestCursorRun(project);
  const lastFrom = project.history?.at(-1)?.from;
  if (!last && (project.iteration > 0 || lastFrom === ProjectState.CURSOR_EXECUTING || project.checkpoint?.type === OperationType.CURSOR)) {
    return ProjectState.CURSOR_EXECUTING;
  }
  if (last && !project.council[`review${last.iteration}`]) return ProjectState.COUNCIL_REVIEW;
  if (last && project.council[`review${last.iteration}`]?.decision?.decision === 'COMPLETE' && !project.council.final) {
    return ProjectState.FINAL_VERIFICATION;
  }
  return ProjectState.SPECIFICATION_READY;
}

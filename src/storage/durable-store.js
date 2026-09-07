import crypto from 'node:crypto';
import { createProjectRecord } from './json-store.js';
import { assembleProject, disassembleProject, jsonValue, promptPreview, toIso } from './project-document.js';
import { sanitizeExport } from '../security/export.js';
import { projectSecurityPolicy } from '../security/policy.js';

export class DurableStore {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async init() {
    return this;
  }

  async create({ idea, projectPath, demo = false, id } = {}) {
    const project = createProjectRecord({ idea, projectPath, demo, id });
    await this.save(project);
    await this.appendEvent(project.id, 'project.created', { demo: Boolean(demo) });
    return this.get(project.id);
  }

  async get(id) {
    const project = await this.adapter.query('SELECT * FROM projects WHERE id = $1', [id]);
    if (!project.rows[0]) {
      const error = new Error(`Project ${id} not found`);
      error.code = 'ENOENT';
      throw error;
    }
    return this.assemble(id, project.rows[0]);
  }

  async list() {
    const projects = await this.adapter.query('SELECT * FROM projects ORDER BY created_at DESC');
    const out = [];
    for (const row of projects.rows) out.push(await this.assemble(row.id, row));
    return out;
  }

  async save(project) {
    project.updatedAt = new Date().toISOString();
    const parts = disassembleProject(project);
    await this.adapter.transact(async tx => {
      await tx.query(`INSERT INTO projects (
        id, idea, product_name, state, project_path, verification_level, iteration, max_iterations,
        demo, active_prompt, delivery, error, checkpoint, permission_log, created_at, updated_at,
        ready_at, approved_at, imported_from_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (id) DO UPDATE SET
        idea = EXCLUDED.idea,
        product_name = EXCLUDED.product_name,
        state = EXCLUDED.state,
        project_path = EXCLUDED.project_path,
        verification_level = EXCLUDED.verification_level,
        iteration = EXCLUDED.iteration,
        max_iterations = EXCLUDED.max_iterations,
        demo = EXCLUDED.demo,
        active_prompt = EXCLUDED.active_prompt,
        delivery = EXCLUDED.delivery,
        error = EXCLUDED.error,
        checkpoint = EXCLUDED.checkpoint,
        permission_log = EXCLUDED.permission_log,
        updated_at = EXCLUDED.updated_at,
        ready_at = EXCLUDED.ready_at,
        approved_at = EXCLUDED.approved_at,
        imported_from_json = EXCLUDED.imported_from_json`, [
        parts.project.id, parts.project.idea, parts.project.product_name, parts.project.state,
        parts.project.project_path, parts.project.verification_level, parts.project.iteration,
        parts.project.max_iterations, parts.project.demo, parts.project.active_prompt,
        jsonb(parts.project.delivery), jsonb(parts.project.error), jsonb(parts.project.checkpoint),
        jsonb(parts.project.permission_log), parts.project.created_at, parts.project.updated_at,
        parts.project.ready_at, parts.project.approved_at, parts.project.imported_from_json
      ]);
      if (project.repository) {
        await tx.query(`INSERT INTO project_repositories (
          project_id, repository_type, repository_source, canonical_path, owner_path, remote_url,
          cloud_repository_url, remote_provider, base_ref, baseline_sha, working_branch, workspace_path,
          owner_working_tree_dirty, cursor_backend, lifecycle_status, cleanup_status, session_map, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18::timestamptz, NOW()),NOW())
        ON CONFLICT (project_id) DO UPDATE SET
          repository_type = EXCLUDED.repository_type,
          repository_source = EXCLUDED.repository_source,
          canonical_path = EXCLUDED.canonical_path,
          owner_path = EXCLUDED.owner_path,
          remote_url = EXCLUDED.remote_url,
          cloud_repository_url = EXCLUDED.cloud_repository_url,
          remote_provider = EXCLUDED.remote_provider,
          base_ref = EXCLUDED.base_ref,
          baseline_sha = EXCLUDED.baseline_sha,
          working_branch = EXCLUDED.working_branch,
          workspace_path = EXCLUDED.workspace_path,
          owner_working_tree_dirty = EXCLUDED.owner_working_tree_dirty,
          cursor_backend = EXCLUDED.cursor_backend,
          lifecycle_status = EXCLUDED.lifecycle_status,
          cleanup_status = EXCLUDED.cleanup_status,
          session_map = EXCLUDED.session_map,
          updated_at = NOW()`, [
          project.id,
          project.repository.repositoryType || 'UNPROVISIONED_NEW_PROJECT',
          project.repository.repositorySource || null,
          project.repository.canonicalPath || null,
          project.repository.ownerPath || null,
          project.repository.remoteUrl || null,
          project.repository.cloudRepositoryUrl || null,
          project.repository.remoteProvider || null,
          project.repository.baseRef || null,
          project.repository.baselineSha || null,
          project.repository.workingBranch || null,
          project.repository.workspacePath || null,
          Boolean(project.repository.ownerWorkingTreeDirty),
          project.repository.cursorBackend || null,
          project.repository.lifecycleStatus || 'ACTIVE',
          project.repository.cleanupStatus || null,
          jsonb(project.repository.sessionMap || []),
          project.repository.createdAt || null
        ]);
        await tx.query(`UPDATE project_repositories SET provisioning_baseline_sha = $2 WHERE project_id = $1`, [
          project.id,
          project.repository.provisioningBaselineSha || null
        ]).catch(() => {});
      }

      for (const item of parts.transitions) {
        await tx.query(`INSERT INTO state_transitions (id, project_id, from_state, to_state, reason, details, at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (project_id, at, from_state, to_state) DO NOTHING`, [
          item.id, project.id, item.from_state, item.to_state, item.reason, jsonb(item.details), item.at
        ]);
      }
      for (const item of parts.operations) {
        await tx.query(`INSERT INTO operations (
          id, project_id, type, phase, iteration, status, attempt, idempotency_key, input, result, error,
          started_at, completed_at, failed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status, result = EXCLUDED.result, error = EXCLUDED.error,
          completed_at = EXCLUDED.completed_at, failed_at = EXCLUDED.failed_at`, [
          item.id, project.id, item.type, item.phase, item.iteration, item.status, item.attempt,
          item.idempotency_key, jsonb(item.input), jsonb(item.result), jsonb(item.error),
          item.started_at, item.completed_at, item.failed_at
        ]);
      }
      for (const item of parts.artifacts) {
        await tx.query(`INSERT INTO council_artifacts (id, project_id, kind, iteration, payload, created_at)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (project_id, kind, iteration) DO UPDATE SET payload = EXCLUDED.payload`, [
          item.id, project.id, item.kind, item.iteration, jsonb(item.payload), item.created_at
        ]);
      }
      for (const item of parts.rounds) {
        await tx.query(`INSERT INTO council_rounds (
          id, project_id, purpose, phase, iteration, reasoning_round, participants, responses, errors,
          disagreements, chair, mapping, at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (id) DO UPDATE SET
          participants = EXCLUDED.participants, responses = EXCLUDED.responses, errors = EXCLUDED.errors,
          disagreements = EXCLUDED.disagreements, chair = EXCLUDED.chair`, [
          item.id, project.id, item.purpose, item.phase, item.iteration, item.reasoning_round,
          jsonb(item.participants), jsonb(item.responses), jsonb(item.errors), jsonb(item.disagreements),
          jsonb(item.chair), jsonb(item.mapping), item.at
        ]);
      }
      for (const item of parts.cursorRuns) {
        await tx.query(`INSERT INTO cursor_runs (
          id, project_id, iteration, attempt, session_id, execution_mode, prompt_preview, status,
          stop_reason, output, evidence, error, started_at, completed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (project_id, iteration, attempt) DO UPDATE SET
          session_id = EXCLUDED.session_id, status = EXCLUDED.status, stop_reason = EXCLUDED.stop_reason,
          output = EXCLUDED.output, evidence = EXCLUDED.evidence, error = EXCLUDED.error,
          completed_at = EXCLUDED.completed_at`, [
          item.id, project.id, item.iteration, item.attempt, item.session_id, item.execution_mode,
          item.prompt_preview, item.status, item.stop_reason, jsonb(item.output), jsonb(item.evidence),
          jsonb(item.error), item.started_at, item.completed_at
        ]);
        if (item.evidence) {
          await tx.query(`INSERT INTO evidence_records (
            id, project_id, cursor_run_id, iteration, verification_level, aspects, artifacts, warnings, errors, source, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (id) DO UPDATE SET
            verification_level = EXCLUDED.verification_level,
            aspects = EXCLUDED.aspects,
            artifacts = EXCLUDED.artifacts,
            warnings = EXCLUDED.warnings,
            errors = EXCLUDED.errors,
            source = EXCLUDED.source`, [
            item.id, project.id, item.id, item.iteration,
            item.evidence.verificationLevel || 'SELF_REPORTED',
            jsonb(evidenceAspects(item.evidence)), jsonb(item.evidence.artifacts || []),
            jsonb(item.evidence.warnings || []), jsonb(item.evidence.errors || []),
            jsonb(item.evidence.source || null), item.completed_at || item.started_at || project.updatedAt
          ]);
        }
      }
      for (const run of project.verificationRuns || []) {
        await tx.query(`INSERT INTO verification_runs (
          id, project_id, iteration, checkpoint_sha, status, project_type, toolchains, plan, policy,
          blocking_failures, problems, config_changed, config_files, started_at, completed_at, reused
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status, plan = EXCLUDED.plan, policy = EXCLUDED.policy,
          blocking_failures = EXCLUDED.blocking_failures, completed_at = EXCLUDED.completed_at, reused = EXCLUDED.reused`, [
          run.id, project.id, run.iteration, run.checkpointSha || `run-${run.id}`,
          run.status, run.projectType || null, jsonb(run.toolchains || []), jsonb(run.plan || null),
          jsonb(run.policy || null), jsonb(run.blockingFailures || []), jsonb(run.problems || []),
          Boolean(run.verificationConfigurationChanged), jsonb(run.verificationConfigFiles || []),
          run.startedAt || null, run.completedAt || null, Boolean(run.reused)
        ]);
        for (const step of run.steps || []) {
          await tx.query(`INSERT INTO verification_steps (
            id, run_id, project_id, step_id, kind, required, status, provenance, command, exit_code,
            duration_ms, stdout_preview, stderr_preview, truncated, log_artifact_id, counts, timed_out
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status, exit_code = EXCLUDED.exit_code, stdout_preview = EXCLUDED.stdout_preview,
            stderr_preview = EXCLUDED.stderr_preview, counts = EXCLUDED.counts`, [
            step.rowId || step.dbId || asStepId(run.id, step.id), run.id, project.id, step.id, step.kind,
            Boolean(step.required), step.status, step.provenance || null, jsonb(step.command || []),
            step.exitCode, step.durationMs, step.stdoutPreview || null, step.stderrPreview || null,
            Boolean(step.truncated), step.logArtifactId || null, jsonb(step.counts || null), Boolean(step.timedOut)
          ]);
        }
        for (const artifact of run.artifacts || []) {
          if (!artifact.id) continue;
          await tx.query(`INSERT INTO verification_artifacts (
            id, project_id, iteration, kind, type, path, size, sha256, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (id) DO NOTHING`, [
            artifact.id, project.id, run.iteration, artifact.kind || artifact.type || 'log',
            artifact.type || artifact.kind || 'log', artifact.path || null, artifact.size || null,
            artifact.sha256 || null, artifact.createdAt || project.updatedAt
          ]);
        }
      }
      await persistPhase6(tx, project);
      await persistPhase7(tx, project);
      await persistPhase8(tx, project);
      for (const item of parts.errors) {
        await tx.query(`INSERT INTO error_records (id, project_id, code, message, phase, retryable, details, at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (id) DO NOTHING`, [
          item.id, project.id, item.code, item.message, item.phase, item.retryable, jsonb(item.details), item.at
        ]);
      }
    });
    return project;
  }

  async appendEvent(projectId, type, payload = {}) {
    await this.adapter.query(
      'INSERT INTO events (id, project_id, type, payload) VALUES ($1,$2,$3,$4)',
      [crypto.randomUUID(), projectId, type, jsonb(sanitizeEvent(payload))]
    );
  }

  async exportProject(id) {
    const project = await this.get(id);
    const events = await this.adapter.query('SELECT * FROM events WHERE project_id = $1 ORDER BY at', [id]);
    const jobs = await this.adapter.query('SELECT * FROM jobs WHERE project_id = $1 ORDER BY created_at', [id]);
    const dump = {
      project,
      transitions: project.history,
      operations: project.operations,
      council: project.council,
      cursorRuns: project.cursorRuns,
      verificationRuns: project.verificationRuns || [],
      runtimeRuns: project.runtimeRuns || [],
      visualReviewRuns: project.visualReviewRuns || [],
      provisioningRuns: project.provisioningRuns || [],
      provisioningPlan: project.provisioningPlan || null,
      provisioning: project.provisioning || null,
      components: project.components || [],
      artifacts: [
        ...(project.verificationRuns || []).flatMap(item => item.artifacts || []),
        ...(project.runtimeRuns || []).flatMap(item => item.screenshots || [])
      ],
      evidence: project.evidence,
      errors: project.errors,
      events: events.rows.map(row => ({
        id: row.id,
        type: row.type,
        payload: jsonValue(row.payload, {}),
        at: toIso(row.at)
      })),
      jobs: jobs.rows.map(row => ({
        id: row.id,
        jobType: row.job_type,
        status: row.status,
        attempts: row.attempts,
        idempotencyKey: row.idempotency_key,
        lastError: jsonValue(row.last_error, null),
        createdAt: toIso(row.created_at),
        completedAt: toIso(row.completed_at)
      })),
      sandboxRuns: project.sandboxRuns || [],
      securityPolicy: project.securityPolicy || null,
      securityFindings: project.securityFindings || [],
      secretReferences: (project.secretReferences || []).map(item => ({
        secretRef: item.secretRef,
        class: item.class
      }))
    };
    return sanitizeExport(dump);
  }

  async assemble(id, row) {
    const [transitions, operations, artifacts, rounds, cursorRuns, errors] = await Promise.all([
      this.adapter.query('SELECT * FROM state_transitions WHERE project_id = $1 ORDER BY at', [id]),
      this.adapter.query('SELECT * FROM operations WHERE project_id = $1 ORDER BY started_at NULLS LAST', [id]),
      this.adapter.query('SELECT * FROM council_artifacts WHERE project_id = $1', [id]),
      this.adapter.query('SELECT * FROM council_rounds WHERE project_id = $1 ORDER BY at', [id]),
      this.adapter.query('SELECT * FROM cursor_runs WHERE project_id = $1 ORDER BY iteration, attempt', [id]),
      this.adapter.query('SELECT * FROM error_records WHERE project_id = $1 ORDER BY at', [id])
    ]);
    const repo = await this.adapter.query('SELECT * FROM project_repositories WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    const verification = await this.adapter.query('SELECT * FROM verification_runs WHERE project_id = $1 ORDER BY iteration, started_at', [id]).catch(() => ({ rows: [] }));
    const steps = await this.adapter.query('SELECT * FROM verification_steps WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    const vArtifacts = await this.adapter.query('SELECT * FROM verification_artifacts WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    const assembled = assembleProject({
      project: row,
      transitions: transitions.rows,
      operations: operations.rows,
      artifacts: artifacts.rows,
      rounds: rounds.rows,
      cursorRuns: cursorRuns.rows,
      errors: errors.rows
    });
    assembled.repository = repo.rows[0] ? fromRepositoryRow(repo.rows[0]) : assembled.repository || null;
    assembled.verificationRuns = verification.rows.map(row => fromVerificationRow(row, steps.rows, vArtifacts.rows));
    const runtime = await this.adapter.query('SELECT * FROM runtime_verification_runs WHERE project_id = $1 ORDER BY iteration, started_at', [id]).catch(() => ({ rows: [] }));
    const scenarios = await this.adapter.query('SELECT * FROM runtime_scenarios WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    const shots = await this.adapter.query('SELECT * FROM screenshots WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    const a11y = await this.adapter.query('SELECT * FROM accessibility_findings WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    const visual = await this.adapter.query('SELECT * FROM visual_review_runs WHERE project_id = $1 ORDER BY iteration, started_at', [id]).catch(() => ({ rows: [] }));
    const visualFindings = await this.adapter.query('SELECT * FROM visual_findings WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    assembled.runtimeRuns = runtime.rows.map(row => fromRuntimeRow(row, scenarios.rows, shots.rows, a11y.rows));
    assembled.visualReviewRuns = visual.rows.map(row => fromVisualRow(row, visualFindings.rows));
    const plans = await this.adapter.query('SELECT * FROM provisioning_plans WHERE project_id = $1 ORDER BY created_at', [id]).catch(() => ({ rows: [] }));
    const provisionRuns = await this.adapter.query('SELECT * FROM provisioning_runs WHERE project_id = $1 ORDER BY started_at', [id]).catch(() => ({ rows: [] }));
    const provisionSteps = await this.adapter.query('SELECT * FROM provisioning_steps WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    const components = await this.adapter.query('SELECT * FROM project_components WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    assembled.provisioningPlan = plans.rows.length ? fromPlanRow(plans.rows[plans.rows.length - 1]) : assembled.provisioningPlan || null;
    assembled.provisioningRuns = provisionRuns.rows.map(row => fromProvisioningRunRow(row, provisionSteps.rows));
    assembled.provisioning = assembled.provisioningRuns.at(-1)
      ? {
        status: assembled.provisioningRuns.at(-1).status,
        provenance: assembled.provisioningRuns.at(-1).evidence?.provenance || null,
        templateId: assembled.provisioningRuns.at(-1).templateId,
        baselineSha: assembled.provisioningRuns.at(-1).baselineSha,
        generatorVersion: assembled.provisioningRuns.at(-1).generator?.version || null,
        planHash: assembled.provisioningRuns.at(-1).planHash
      }
      : assembled.provisioning || null;
    assembled.components = components.rows.map(row => ({
      id: row.component_id,
      path: row.path,
      profile: jsonValue(row.profile, null),
      provisioner: row.provisioner,
      templateId: row.template_id,
      status: row.status
    }));
    if (assembled.repository && repo.rows[0]?.provisioning_baseline_sha) {
      assembled.repository.provisioningBaselineSha = repo.rows[0].provisioning_baseline_sha;
    }
    const sandbox = await this.adapter.query('SELECT * FROM sandbox_runs WHERE project_id = $1 ORDER BY started_at', [id]).catch(() => ({ rows: [] }));
    const findings = await this.adapter.query('SELECT * FROM security_findings WHERE project_id = $1 ORDER BY at', [id]).catch(() => ({ rows: [] }));
    const policy = await this.adapter.query('SELECT * FROM project_security_policies WHERE project_id = $1', [id]).catch(() => ({ rows: [] }));
    assembled.sandboxRuns = sandbox.rows.map(row => ({
      sandboxRunId: row.id,
      projectId: row.project_id,
      iteration: row.iteration,
      backend: row.backend,
      mode: row.mode,
      imageDigest: row.image_digest,
      policy: jsonValue(row.policy, null),
      networkPolicy: row.network_policy,
      resourceLimits: jsonValue(row.resource_limits, null),
      isolationCapabilities: jsonValue(row.isolation_capabilities, null),
      status: row.status,
      startedAt: toIso(row.started_at),
      completedAt: toIso(row.completed_at)
    }));
    assembled.securityFindings = findings.rows.map(row => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      code: row.code,
      message: row.message,
      blocking: Boolean(row.blocking)
    }));
    assembled.securityPolicy = policy.rows[0]
      ? jsonValue(policy.rows[0].payload, { profile: policy.rows[0].profile, requiredSandboxMode: policy.rows[0].required_sandbox_mode })
      : assembled.securityPolicy || projectSecurityPolicy(assembled);
    assembled.sandboxProvenance = assembled.sandboxRuns.at(-1) || assembled.sandboxProvenance || null;
    return assembled;
  }
}

function jsonb(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function evidenceAspects(evidence) {
  const keys = ['execution', 'git', 'build', 'tests', 'lint', 'runtime', 'visual'];
  const aspects = {};
  for (const key of keys) {
    if (evidence[key]) aspects[key] = evidence[key];
  }
  return aspects;
}

function fromRepositoryRow(row) {
  return {
    repositoryType: row.repository_type,
    repositorySource: row.repository_source,
    canonicalPath: row.canonical_path,
    ownerPath: row.owner_path,
    remoteUrl: row.remote_url,
    cloudRepositoryUrl: row.cloud_repository_url,
    remoteProvider: row.remote_provider,
    baseRef: row.base_ref,
    baselineSha: row.baseline_sha,
    workingBranch: row.working_branch,
    workspacePath: row.workspace_path,
    ownerWorkingTreeDirty: Boolean(row.owner_working_tree_dirty),
    cursorBackend: row.cursor_backend,
    lifecycleStatus: row.lifecycle_status,
    cleanupStatus: row.cleanup_status,
    sessionMap: jsonValue(row.session_map, []),
    createdAt: toIso(row.created_at)
  };
}

function asStepId(runId, stepId) {
  const hex = crypto.createHash('sha256').update(`${runId}:${stepId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function fromVerificationRow(row, steps, artifacts) {
  return {
    id: row.id,
    projectId: row.project_id,
    iteration: Number(row.iteration),
    checkpointSha: row.checkpoint_sha,
    status: row.status,
    projectType: row.project_type,
    toolchains: jsonValue(row.toolchains, []),
    plan: jsonValue(row.plan, null),
    policy: jsonValue(row.policy, null),
    blockingFailures: jsonValue(row.blocking_failures, []),
    problems: jsonValue(row.problems, []),
    verificationConfigurationChanged: Boolean(row.config_changed),
    verificationConfigFiles: jsonValue(row.config_files, []),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    reused: Boolean(row.reused),
    steps: steps.filter(item => item.run_id === row.id).map(item => ({
      id: item.step_id,
      kind: item.kind,
      required: Boolean(item.required),
      status: item.status,
      provenance: item.provenance,
      command: jsonValue(item.command, []),
      exitCode: item.exit_code,
      durationMs: item.duration_ms,
      stdoutPreview: item.stdout_preview,
      stderrPreview: item.stderr_preview,
      truncated: Boolean(item.truncated),
      logArtifactId: item.log_artifact_id,
      counts: jsonValue(item.counts, null),
      timedOut: Boolean(item.timed_out)
    })),
    artifacts: artifacts.filter(item => item.project_id === row.project_id && Number(item.iteration) === Number(row.iteration))
      .map(item => ({
        id: item.id,
        kind: item.kind,
        type: item.type,
        path: item.path,
        size: item.size == null ? null : Number(item.size),
        sha256: item.sha256,
        createdAt: toIso(item.created_at)
      }))
  };
}

async function persistPhase6(tx, project) {
  for (const run of project.runtimeRuns || []) {
    await tx.query(`INSERT INTO runtime_verification_runs (
      id, project_id, iteration, checkpoint_sha, artifact_hash, adapter, application_kind, status,
      plan, policy, launch, diagnostics, blocking_failures, problems, reused, started_at, completed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status, diagnostics = EXCLUDED.diagnostics, blocking_failures = EXCLUDED.blocking_failures,
      completed_at = EXCLUDED.completed_at, reused = EXCLUDED.reused`, [
      run.id, project.id, run.iteration, run.checkpointSha || null, run.artifactHash || null,
      run.adapter || null, run.applicationKind || null, run.status, jsonb(run.plan || null),
      jsonb(run.policy || null), jsonb(run.launch || null), jsonb(run.diagnostics || []),
      jsonb(run.blockingFailures || []), jsonb(run.problems || []), Boolean(run.reused),
      run.startedAt || null, run.completedAt || null
    ]);
    for (const scenario of run.scenarios || []) {
      const scenarioId = scenario.rowId || crypto.randomUUID();
      scenario.rowId = scenarioId;
      await tx.query(`INSERT INTO runtime_scenarios (
        id, run_id, project_id, scenario_id, goal, priority, status, steps, assertions, failures, artifacts, duration_ms, started_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, steps = EXCLUDED.steps, failures = EXCLUDED.failures`, [
        scenarioId, run.id, project.id, scenario.id, scenario.goal || null, scenario.priority || null,
        scenario.status, jsonb(scenario.steps || []), jsonb(scenario.assertions || []),
        jsonb(scenario.failures || []), jsonb(scenario.artifacts || []), scenario.durationMs || null,
        scenario.startedAt || null, scenario.completedAt || null
      ]);
    }
    for (const shot of run.screenshots || []) {
      if (!shot.id) continue;
      await tx.query(`INSERT INTO screenshots (
        id, project_id, runtime_run_id, iteration, scenario_id, step, platform, browser, device, viewport,
        width, height, route, path, sha256, checkpoint_sha, artifact_hash, baseline_kind, masks, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (id) DO NOTHING`, [
        shot.id, project.id, run.id, run.iteration, shot.scenarioId || null, shot.step || null,
        shot.platform || 'web', shot.browser || null, shot.device || null, shot.viewport || null,
        shot.width || null, shot.height || null, shot.route || null, shot.path || null, shot.sha256 || null,
        shot.checkpointSha || run.checkpointSha || null, shot.artifactHash || run.artifactHash || null,
        shot.baselineKind || 'NO_BASELINE', jsonb(shot.masks || []), shot.createdAt || project.updatedAt
      ]);
    }
    for (const group of run.accessibility || []) {
      for (const finding of group.findings || []) {
        await tx.query(`INSERT INTO accessibility_findings (
          id, project_id, runtime_run_id, scenario_id, severity, category, code, description, blocking, provenance, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (id) DO NOTHING`, [
          finding.id || crypto.randomUUID(), project.id, run.id, group.scenario || null,
          finding.severity || 'MEDIUM', finding.category || null, finding.code || null,
          finding.description || null, Boolean(finding.blocking), finding.provenance || 'PLATFORM_VERIFIED'
        ]);
      }
    }
  }
  for (const run of project.visualReviewRuns || []) {
    await tx.query(`INSERT INTO visual_review_runs (
      id, project_id, runtime_run_id, iteration, screenshot_set_hash, checkpoint_sha, status, decision,
      reviewers, chair, blocking_findings, usage, started_at, completed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status, decision = EXCLUDED.decision, blocking_findings = EXCLUDED.blocking_findings,
      completed_at = EXCLUDED.completed_at`, [
      run.id, project.id, run.runtimeRunId || null, run.iteration, run.screenshotSetHash || null,
      run.checkpointSha || null, run.status, run.decision || null, jsonb(run.reviewers || []),
      jsonb(run.chair || null), jsonb(run.blockingFindings || []), jsonb(run.usage || null),
      run.startedAt || null, run.completedAt || null
    ]);
    for (const finding of run.findings || []) {
      await tx.query(`INSERT INTO visual_findings (
        id, review_run_id, project_id, reviewer, screen, device, severity, category, description, evidence, region, required_fix, provenance, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (id) DO NOTHING`, [
        finding.id || crypto.randomUUID(), run.id, project.id, finding.reviewer || null,
        finding.screen || null, finding.device || null, finding.severity, finding.category || null,
        finding.description || finding.issue || null, finding.evidence || null, jsonb(finding.region || null),
        finding.requiredFix || null, finding.provenance || 'AI_REVIEWED'
      ]);
    }
  }
}

function fromRuntimeRow(row, scenarios, shots, a11y) {
  return {
    id: row.id,
    projectId: row.project_id,
    iteration: Number(row.iteration),
    checkpointSha: row.checkpoint_sha,
    artifactHash: row.artifact_hash,
    adapter: row.adapter,
    applicationKind: row.application_kind,
    status: row.status,
    plan: jsonValue(row.plan, null),
    policy: jsonValue(row.policy, null),
    launch: jsonValue(row.launch, null),
    diagnostics: jsonValue(row.diagnostics, []),
    blockingFailures: jsonValue(row.blocking_failures, []),
    problems: jsonValue(row.problems, []),
    reused: Boolean(row.reused),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    scenarios: scenarios.filter(item => item.run_id === row.id).map(item => ({
      id: item.scenario_id,
      goal: item.goal,
      priority: item.priority,
      status: item.status,
      steps: jsonValue(item.steps, []),
      assertions: jsonValue(item.assertions, []),
      failures: jsonValue(item.failures, []),
      artifacts: jsonValue(item.artifacts, []),
      durationMs: item.duration_ms
    })),
    screenshots: shots.filter(item => item.runtime_run_id === row.id).map(item => ({
      id: item.id,
      path: item.path,
      sha256: item.sha256,
      viewport: item.viewport,
      width: item.width,
      height: item.height,
      route: item.route,
      checkpointSha: item.checkpoint_sha,
      artifactHash: item.artifact_hash,
      baselineKind: item.baseline_kind
    })),
    accessibility: a11y.filter(item => item.runtime_run_id === row.id).length
      ? [{ findings: a11y.filter(item => item.runtime_run_id === row.id) }]
      : []
  };
}

function fromVisualRow(row, findings) {
  return {
    id: row.id,
    projectId: row.project_id,
    runtimeRunId: row.runtime_run_id,
    iteration: Number(row.iteration),
    screenshotSetHash: row.screenshot_set_hash,
    checkpointSha: row.checkpoint_sha,
    status: row.status,
    decision: row.decision,
    reviewers: jsonValue(row.reviewers, []),
    chair: jsonValue(row.chair, null),
    blockingFindings: jsonValue(row.blocking_findings, []),
    usage: jsonValue(row.usage, null),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    findings: findings.filter(item => item.review_run_id === row.id).map(item => ({
      id: item.id,
      reviewer: item.reviewer,
      screen: item.screen,
      device: item.device,
      severity: item.severity,
      category: item.category,
      description: item.description,
      evidence: item.evidence,
      region: jsonValue(item.region, null),
      requiredFix: item.required_fix,
      provenance: item.provenance
    }))
  };
}

async function persistPhase7(tx, project) {
  if (project.provisioningPlan?.provisioner && project.provisioningPlan?.hash) {
    const plan = project.provisioningPlan;
    await tx.query(`INSERT INTO provisioning_plans (
      id, project_id, plan_hash, provisioner, template_id, support_status, profile, identity, generator,
      capabilities_required, steps, payload, version
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (project_id, plan_hash) DO UPDATE SET
      payload = EXCLUDED.payload, generator = EXCLUDED.generator, support_status = EXCLUDED.support_status`, [
      plan.rowId || crypto.randomUUID(), project.id, plan.hash, plan.provisioner, plan.templateId || null,
      plan.supportStatus || null, jsonb(plan.profile || null), jsonb(plan.identity || null),
      jsonb(plan.generator || null), jsonb(plan.capabilitiesRequired || []), jsonb(plan.steps || []),
      jsonb(plan), 1
    ]);
  }
  for (const run of project.provisioningRuns || []) {
    await tx.query(`INSERT INTO provisioning_runs (
      id, project_id, plan_hash, provisioner, template_id, status, support_status, baseline_sha, generator,
      toolchain_versions, created_files, blocking_failures, starter_verification, evidence, reused, started_at, completed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status, baseline_sha = EXCLUDED.baseline_sha, completed_at = EXCLUDED.completed_at,
      evidence = EXCLUDED.evidence, reused = EXCLUDED.reused`, [
      run.id, project.id, run.planHash || null, run.provisioner || null, run.templateId || null,
      run.status, run.supportStatus || null, run.baselineSha || null, jsonb(run.generator || null),
      jsonb(run.toolchainVersions || null), jsonb(run.createdFiles || []), jsonb(run.blockingFailures || []),
      jsonb(run.starterVerification || null), jsonb(run.evidence || null), Boolean(run.reused),
      run.startedAt || null, run.completedAt || null
    ]);
    for (const step of run.steps || []) {
      await tx.query(`INSERT INTO provisioning_steps (
        id, run_id, project_id, step_id, kind, required, status, command, exit_code, duration_ms, stdout_preview, stderr_preview
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`, [
        step.rowId || crypto.randomUUID(), run.id, project.id, step.id, step.kind, step.required !== false,
        step.status, jsonb(step.command || []), step.exitCode ?? null, step.durationMs ?? null,
        step.stdoutPreview || null, step.stderrPreview || null
      ]);
    }
  }
  for (const component of project.components || []) {
    await tx.query(`INSERT INTO project_components (
      id, project_id, component_id, path, profile, provisioner, template_id, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (project_id, component_id) DO UPDATE SET
      status = EXCLUDED.status, provisioner = EXCLUDED.provisioner, template_id = EXCLUDED.template_id`, [
      component.rowId || crypto.randomUUID(), project.id, component.id, component.path || '.',
      jsonb(component.profile || null), component.provisioner || null, component.templateId || null,
      component.status || 'PLANNED'
    ]);
  }
}

function fromPlanRow(row) {
  const payload = jsonValue(row.payload, {});
  return {
    ...payload,
    hash: row.plan_hash,
    provisioner: row.provisioner,
    templateId: row.template_id,
    supportStatus: row.support_status,
    profile: jsonValue(row.profile, payload.profile || null),
    identity: jsonValue(row.identity, payload.identity || null),
    generator: jsonValue(row.generator, payload.generator || null),
    capabilitiesRequired: jsonValue(row.capabilities_required, []),
    steps: jsonValue(row.steps, payload.steps || [])
  };
}

function fromProvisioningRunRow(row, steps) {
  return {
    id: row.id,
    projectId: row.project_id,
    planHash: row.plan_hash,
    provisioner: row.provisioner,
    templateId: row.template_id,
    status: row.status,
    supportStatus: row.support_status,
    baselineSha: row.baseline_sha,
    generator: jsonValue(row.generator, null),
    toolchainVersions: jsonValue(row.toolchain_versions, null),
    createdFiles: jsonValue(row.created_files, []),
    blockingFailures: jsonValue(row.blocking_failures, []),
    starterVerification: jsonValue(row.starter_verification, null),
    evidence: jsonValue(row.evidence, null),
    reused: Boolean(row.reused),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    steps: steps.filter(item => item.run_id === row.id).map(item => ({
      id: item.step_id,
      kind: item.kind,
      required: Boolean(item.required),
      status: item.status,
      command: jsonValue(item.command, []),
      exitCode: item.exit_code,
      durationMs: item.duration_ms,
      stdoutPreview: item.stdout_preview,
      stderrPreview: item.stderr_preview
    }))
  };
}

async function persistPhase8(tx, project) {
  const policy = project.securityPolicy || projectSecurityPolicy(project);
  await tx.query(`INSERT INTO project_security_policies (
    project_id, profile, required_sandbox_mode, network_policy, payload, updated_at
  ) VALUES ($1,$2,$3,$4,$5,NOW())
  ON CONFLICT (project_id) DO UPDATE SET
    profile = EXCLUDED.profile, required_sandbox_mode = EXCLUDED.required_sandbox_mode,
    network_policy = EXCLUDED.network_policy, payload = EXCLUDED.payload, updated_at = NOW()`, [
    project.id, policy.profile, policy.requiredSandboxMode, policy.networkPolicy || null, jsonb(policy)
  ]).catch(() => {});
  for (const run of project.sandboxRuns || []) {
    await tx.query(`INSERT INTO sandbox_runs (
      id, project_id, iteration, backend, mode, image_digest, policy, network_policy, resource_limits,
      isolation_capabilities, status, started_at, completed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, completed_at = EXCLUDED.completed_at`, [
      run.sandboxRunId || run.id, project.id, run.iteration || 0, run.backend, run.mode,
      run.imageDigest || null, jsonb(run.policy || null), run.networkPolicy || null,
      jsonb(run.resourceLimits || null), jsonb(run.isolationCapabilities || null),
      run.status || 'STARTED', run.startedAt || null, run.completedAt || null
    ]).catch(() => {});
  }
  for (const finding of project.securityFindings || []) {
    await tx.query(`INSERT INTO security_findings (
      id, project_id, kind, severity, code, message, blocking, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO NOTHING`, [
      finding.id, project.id, finding.kind, finding.severity || null, finding.code || null,
      finding.message || null, finding.blocking !== false, jsonb(finding)
    ]).catch(() => {});
  }
}

function sanitizeEvent(payload) {
  const out = { ...payload };
  delete out.prompt;
  delete out.cursorPrompt;
  if (out.promptPreview) out.promptPreview = promptPreview(out.promptPreview);
  return out;
}

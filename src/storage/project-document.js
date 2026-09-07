import crypto from 'node:crypto';
import { createProjectRecord } from './json-store.js';

export function asUuid(value) {
  if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
  return crypto.randomUUID();
}

export function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function jsonValue(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

export function promptPreview(prompt) {
  const text = String(prompt || '');
  return text ? text.slice(0, 240) : null;
}

export function assembleProject({
  project,
  transitions = [],
  operations = [],
  artifacts = [],
  rounds = [],
  cursorRuns = [],
  errors = []
}) {
  const council = {};
  const discovery = artifacts.find(item => item.kind === 'discovery');
  if (discovery) {
    council.discovery = {
      ...jsonValue(discovery.payload, {}),
      history: rounds.filter(round => round.phase === 'COUNCIL_DISCOVERY').map(fromRoundRow)
    };
  }
  for (const artifact of artifacts.filter(item => item.kind === 'review')) {
    council[`review${artifact.iteration}`] = {
      ...jsonValue(artifact.payload, {}),
      history: rounds.filter(round => round.phase === 'COUNCIL_REVIEW' && Number(round.iteration) === Number(artifact.iteration)).map(fromRoundRow)
    };
  }
  const finals = artifacts.filter(item => item.kind === 'final').sort((a, b) => Number(a.iteration) - Number(b.iteration));
  if (finals.length) {
    const current = finals[finals.length - 1];
    const payload = jsonValue(current.payload, {});
    council.final = {
      ...payload,
      history: rounds.filter(round => round.phase === 'FINAL_VERIFICATION').map(fromRoundRow)
    };
    if (finals.length > 1) {
      council.finalHistory = finals.slice(0, -1).map(item => jsonValue(item.payload, {}));
    }
  }

  const record = createProjectRecord({
    id: project.id,
    idea: project.idea,
    projectPath: project.project_path,
    demo: Boolean(project.demo)
  });
  Object.assign(record, {
    state: project.state,
    createdAt: toIso(project.created_at) || record.createdAt,
    updatedAt: toIso(project.updated_at) || record.updatedAt,
    iteration: Number(project.iteration || 0),
    history: transitions.map(item => ({
      at: toIso(item.at),
      from: item.from_state,
      to: item.to_state,
      note: item.reason,
      details: jsonValue(item.details, {})
    })),
    council,
    cursorRuns: cursorRuns.map(fromCursorRow),
    operations: operations.map(fromOperationRow),
    checkpoint: jsonValue(project.checkpoint, record.checkpoint),
    activePrompt: project.active_prompt,
    evidence: latestEvidence(cursorRuns) || null,
    verificationLevel: project.verification_level,
    permissionLog: jsonValue(project.permission_log, []),
    delivery: jsonValue(project.delivery, null),
    error: jsonValue(project.error, null),
    errors: errors.map(item => ({
      code: item.code,
      message: item.message,
      phase: item.phase,
      retryable: item.retryable,
      at: toIso(item.at),
      details: jsonValue(item.details, {})
    })),
    demo: Boolean(project.demo)
  });
  if (record.delivery?.readyAt == null && project.ready_at) {
    record.delivery = { ...(record.delivery || {}), readyAt: toIso(project.ready_at) };
  }
  return record;
}

export function disassembleProject(project) {
  const now = new Date().toISOString();
  const spec = project.council?.discovery?.spec;
  const artifacts = [];
  const rounds = [];
  if (project.council?.discovery) {
    const { history = [], ...payload } = project.council.discovery;
    artifacts.push({
      id: crypto.randomUUID(),
      kind: 'discovery',
      iteration: 0,
      payload,
      created_at: now
    });
    for (const round of history) rounds.push(toRoundRow(project.id, round, 'COUNCIL_DISCOVERY', 0));
  }
  for (const [key, value] of Object.entries(project.council || {})) {
    const match = /^review(\d+)$/.exec(key);
    if (!match || !value) continue;
    const iteration = Number(match[1]);
    const { history = [], ...payload } = value;
    artifacts.push({
      id: crypto.randomUUID(),
      kind: 'review',
      iteration,
      payload,
      created_at: now
    });
    for (const round of history) rounds.push(toRoundRow(project.id, round, 'COUNCIL_REVIEW', iteration));
  }
  const finals = [...(project.council?.finalHistory || [])];
  if (project.council?.final) finals.push(project.council.final);
  finals.forEach((value, index) => {
    const { history = [], ...payload } = value || {};
    artifacts.push({
      id: crypto.randomUUID(),
      kind: 'final',
      iteration: payload.cursorCount ?? index + 1,
      payload,
      created_at: now
    });
    if (value === project.council?.final) {
      for (const round of history) rounds.push(toRoundRow(project.id, round, 'FINAL_VERIFICATION', payload.cursorCount || 0));
    }
  });

  return {
    project: {
      id: project.id,
      idea: project.idea,
      product_name: spec?.productName || spec?.product?.name || project.delivery?.productName || null,
      state: project.state,
      project_path: project.projectPath || null,
      verification_level: project.verificationLevel || null,
      iteration: project.iteration || 0,
      max_iterations: project.maxIterations || 12,
      demo: Boolean(project.demo),
      active_prompt: project.activePrompt || null,
      delivery: project.delivery || null,
      error: project.error || null,
      checkpoint: project.checkpoint || null,
      permission_log: project.permissionLog || [],
      created_at: project.createdAt || now,
      updated_at: project.updatedAt || now,
      ready_at: project.delivery?.readyAt || null,
      approved_at: project.approvedAt || null,
      imported_from_json: Boolean(project.importedFromJson)
    },
    transitions: (project.history || []).map(item => ({
      id: asUuid(item.id),
      from_state: item.from,
      to_state: item.to,
      reason: item.note || null,
      details: item.details || {},
      at: item.at || now
    })),
    operations: (project.operations || []).map(item => ({
      id: asUuid(item.id),
      type: item.type,
      phase: item.phase || item.type,
      iteration: item.iteration ?? project.iteration ?? 0,
      status: item.status,
      attempt: item.attempt || 1,
      idempotency_key: item.idempotencyKey || `project:${project.id}:op:${item.id || item.type}:${item.iteration ?? 0}`,
      input: item.input || (item.prompt ? { promptPreview: promptPreview(item.prompt) } : null),
      result: item.result || null,
      error: item.error || null,
      started_at: item.startedAt || null,
      completed_at: item.completedAt || null,
      failed_at: item.error ? item.completedAt || now : null
    })),
    artifacts,
    rounds,
    cursorRuns: (project.cursorRuns || []).map((item, index) => toCursorRow(project.id, item, index)),
    errors: (project.errors || []).map(item => ({
      id: asUuid(item.id),
      code: item.code || null,
      message: item.message || null,
      phase: item.phase || null,
      retryable: item.retryable !== false,
      details: item.details || {},
      at: item.at || now
    }))
  };
}

function toRoundRow(projectId, round, phase, iteration) {
  return {
    id: asUuid(round.id),
    project_id: projectId,
    purpose: round.purpose,
    phase: round.phase || phase,
    iteration: round.iteration ?? iteration,
    reasoning_round: round.reasoningRound ?? null,
    participants: round.participants || [],
    responses: round.responses || [],
    errors: round.errors || [],
    disagreements: round.disagreements || [],
    chair: round.chair || null,
    mapping: round.mapping || null,
    at: round.at || new Date().toISOString()
  };
}

function fromRoundRow(round) {
  return {
    id: round.id,
    purpose: round.purpose,
    phase: round.phase,
    iteration: Number(round.iteration || 0),
    reasoningRound: round.reasoning_round,
    at: toIso(round.at),
    participants: jsonValue(round.participants, []),
    responses: jsonValue(round.responses, []),
    errors: jsonValue(round.errors, []),
    chair: jsonValue(round.chair, null),
    mapping: jsonValue(round.mapping, null),
    disagreements: jsonValue(round.disagreements, [])
  };
}

function toCursorRow(projectId, item, index) {
  const result = item.result || null;
  const status = item.status || (result ? 'COMPLETED' : item.error ? 'FAILED' : 'STARTED');
  return {
    id: asUuid(item.id),
    project_id: projectId,
    iteration: item.iteration ?? index + 1,
    attempt: item.attempt || 1,
    session_id: item.sessionId || null,
    execution_mode: item.executionMode || item.mode || null,
    prompt_preview: promptPreview(item.prompt),
    status,
    stop_reason: item.stopReason || result?.stopReason || null,
    output: result,
    evidence: item.evidence || result?.evidence || null,
    error: item.error || null,
    started_at: item.startedAt || item.at || null,
    completed_at: status === 'COMPLETED' ? item.completedAt || item.at || new Date().toISOString() : item.completedAt || null
  };
}

function fromCursorRow(row) {
  const result = jsonValue(row.output, null);
  return {
    id: row.id,
    iteration: Number(row.iteration),
    attempt: Number(row.attempt || 1),
    at: toIso(row.completed_at || row.started_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    prompt: row.prompt_preview,
    result,
    sessionId: row.session_id,
    executionMode: row.execution_mode,
    status: row.status,
    stopReason: row.stop_reason,
    evidence: jsonValue(row.evidence, result?.evidence || null),
    error: jsonValue(row.error, null),
    git: result?.git || jsonValue(row.git, null),
    changedFiles: result?.changedFiles || [],
    checkpointSha: result?.checkpointSha || null,
    uncertainty: result?.uncertainty || null,
    agentId: result?.session?.agentId || null,
    cloudRunId: result?.session?.runId || null
  };
}

function fromOperationRow(row) {
  return {
    id: row.id,
    type: row.type,
    phase: row.phase,
    status: row.status,
    iteration: row.iteration,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key,
    input: jsonValue(row.input, null),
    result: jsonValue(row.result, null),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    error: jsonValue(row.error, null)
  };
}

function latestEvidence(cursorRuns) {
  for (let i = cursorRuns.length - 1; i >= 0; i -= 1) {
    const evidence = jsonValue(cursorRuns[i].evidence, null);
    if (evidence) return evidence;
  }
  return null;
}

export const CursorMode = Object.freeze({
  ACP: 'ACP',
  CLOUD: 'CLOUD',
  MOCK: 'MOCK'
});

export const CursorRunStatus = Object.freeze({
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED'
});

export const CursorUncertainty = Object.freeze({
  NONE: 'NONE',
  PROCESS_FAILED_BEFORE_EXECUTION: 'PROCESS_FAILED_BEFORE_EXECUTION',
  EXECUTION_MAY_HAVE_STARTED: 'EXECUTION_MAY_HAVE_STARTED',
  EXECUTION_COMPLETED: 'EXECUTION_COMPLETED',
  UNCOMMITTED_CHANGES: 'UNCOMMITTED_CHANGES',
  SESSION_RESTARTED: 'SESSION_RESTARTED'
});

export function createCursorContract(input = {}) {
  const workspace = input.workspace || {};
  const task = input.task || {};
  const session = input.session || {};
  const result = input.result || {};
  const git = input.git || {};
  return {
    projectId: input.projectId || null,
    cursorRunId: input.cursorRunId || null,
    iteration: Number(input.iteration || 0),
    executionMode: input.executionMode || CursorMode.MOCK,
    workspace: {
      repository: workspace.repository || workspace.canonicalPath || workspace.ownerPath || null,
      workspacePath: workspace.workspacePath || null,
      baseRef: workspace.baseRef || null,
      baselineSha: workspace.baselineSha || null,
      workingBranch: workspace.workingBranch || null
    },
    task: {
      prompt: task.prompt || '',
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : []
    },
    session: {
      sessionId: session.sessionId || null,
      agentId: session.agentId || null,
      runId: session.runId || null,
      restarted: Boolean(session.restarted)
    },
    result: {
      status: result.status || CursorRunStatus.STARTED,
      stopReason: result.stopReason || null,
      summary: result.summary || ''
    },
    git: {
      beforeSha: git.beforeSha || null,
      afterSha: git.afterSha || null,
      branch: git.branch || null,
      changedFiles: Array.isArray(git.changedFiles) ? git.changedFiles : [],
      diffStat: git.diffStat && typeof git.diffStat === 'object' ? git.diffStat : {},
      dirty: Boolean(git.dirty),
      checkpointSha: git.checkpointSha || null
    },
    evidence: input.evidence || null,
    permissionLog: Array.isArray(input.permissionLog) ? input.permissionLog : [],
    uncertainty: input.uncertainty || CursorUncertainty.NONE,
    timestamps: {
      startedAt: input.timestamps?.startedAt || null,
      completedAt: input.timestamps?.completedAt || null
    },
    output: input.output || '',
    stderr: input.stderr || '',
    updates: Array.isArray(input.updates) ? input.updates : []
  };
}

export function slimCursorReviewInput(run, contract = null) {
  const source = contract || run?.result || {};
  const git = source.git || run?.git || {};
  const files = source.changedFiles || git.changedFiles || run?.changedFiles || [];
  return {
    status: run?.status || source.result?.status || null,
    stopReason: source.result?.stopReason || source.stopReason || run?.stopReason || null,
    summary: String(source.result?.summary || source.output || '').slice(0, 1500),
    executionMode: source.executionMode || run?.executionMode || null,
    sessionId: source.session?.sessionId || run?.sessionId || null,
    agentId: source.session?.agentId || null,
    runId: source.session?.runId || null,
    workspace: {
      workspacePath: source.workspace?.workspacePath || null,
      workingBranch: source.workspace?.workingBranch || git.branch || null,
      baselineSha: source.workspace?.baselineSha || git.beforeSha || null
    },
    git: {
      beforeSha: git.beforeSha || null,
      afterSha: git.afterSha || git.checkpointSha || null,
      branch: git.branch || null,
      dirty: Boolean(git.dirty),
      diffStat: git.diffStat || {},
      checkpointSha: git.checkpointSha || null
    },
    changedFiles: (Array.isArray(files) ? files : []).slice(0, 200).map(item => (
      typeof item === 'string' ? { path: item, status: 'modified' } : {
        path: item.path,
        status: item.status,
        tracked: item.tracked,
        withinWorkspace: item.withinWorkspace
      }
    )),
    uncertainty: source.uncertainty || run?.uncertainty || null,
    evidence: run?.evidence || source.evidence || null
  };
}

export function resolveCursorBackend(project, fallback = CursorMode.ACP) {
  const persisted = project?.repository?.cursorBackend;
  if (persisted) return persisted;
  return fallback;
}

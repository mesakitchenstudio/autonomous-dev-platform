import { mockEvidence } from '../orchestrator/evidence.js';
import { createCursorContract, CursorMode, CursorRunStatus, CursorUncertainty } from './contract.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export class MockCursorClient {
  constructor({ mutate } = {}) {
    this.mutate = mutate || null;
    this.cancelled = false;
  }

  async cancel() {
    this.cancelled = true;
    return { attempted: true, reason: 'cancelled' };
  }

  async run(input = {}) {
    const cwd = input.cwd || input.workspace?.workspacePath || null;
    if (typeof this.mutate === 'function') await this.mutate(input, cwd);
    else if (cwd && input.writeFile) {
      await fs.writeFile(path.join(cwd, input.writeFile.path), input.writeFile.contents, 'utf8');
    }
    const evidence = mockEvidence({ prompt: input.prompt });
    const contract = createCursorContract({
      projectId: input.projectId,
      cursorRunId: input.cursorRunId,
      iteration: input.iteration,
      executionMode: CursorMode.MOCK,
      workspace: { ...input.workspace, workspacePath: cwd },
      task: { prompt: input.prompt, acceptanceCriteria: input.acceptanceCriteria || [] },
      session: { sessionId: input.sessionId || 'mock-session' },
      result: {
        status: CursorRunStatus.COMPLETED,
        stopReason: 'end_turn',
        summary: 'Demo Cursor run completed. No real repository changes were made.'
      },
      output: 'Demo Cursor run completed. No real repository changes were made.',
      evidence,
      uncertainty: CursorUncertainty.EXECUTION_COMPLETED,
      timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }
    });
    contract.sessionId = contract.session.sessionId;
    contract.stopReason = 'end_turn';
    contract.evidence = evidence;
    return contract;
  }
}

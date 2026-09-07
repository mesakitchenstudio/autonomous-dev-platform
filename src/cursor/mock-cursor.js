import { mockEvidence } from '../orchestrator/evidence.js';

export class MockCursorClient {
  async run({ prompt, sessionId = null }) {
    const evidence = mockEvidence({ prompt });
    return {
      sessionId: sessionId || 'mock-session',
      stopReason: 'end_turn',
      output: 'Demo Cursor run completed. No real repository changes were made.',
      updates: [],
      stderr: '',
      evidence
    };
  }
}

import { ModelProvider } from './provider.js';

export class MockProvider extends ModelProvider {
  constructor(name) { super({ name, model: 'mock' }); }
  async complete({ prompt }) {
    if (prompt.includes('FINAL_VERIFICATION_DECISION')) return JSON.stringify({ decision: 'COMPLETE', blockingFindings: [], summary: 'Demo verification passed.' });
    if (prompt.includes('IMPLEMENTATION_REVIEW_DECISION')) return JSON.stringify({ decision: 'COMPLETE', findings: [], nextCursorPrompt: null, summary: 'Demo review accepted.' });
    if (prompt.includes('CHAIR_SYNTHESIS')) return JSON.stringify({
      productName: 'Generated Application', productSummary: 'A domain-appropriate application generated from the owner idea.',
      projectType: 'auto', requirements: ['Implement the owner idea end-to-end','Use maintainable platform conventions','Include tests and runtime verification'],
      architecture: ['Inspect existing repository when provided','Choose a maintainable architecture appropriate to the target platform'],
      workPackages: [{id:'foundation',title:'Implement complete application',acceptanceCriteria:['Build succeeds','Tests pass','Core flows run']}],
      cursorPrompt: `Implement the owner idea completely. Inspect the repository first. Build, test, and verify the application. Do not ask the owner ordinary implementation questions. Return changed files, build/test results, screenshots/artifacts if available, and unresolved issues.`,
      ownerAssumptions: []
    });
    return JSON.stringify({ perspective: this.name, recommendations: ['Favor a simple maintainable implementation','Verify the finished user experience'], risks: [], missingRequirements: [] });
  }
}

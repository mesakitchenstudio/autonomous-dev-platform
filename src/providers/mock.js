import { ModelProvider } from './provider.js';

export function demoCursorPrompt(idea = 'the owner idea') {
  return [
    'OBJECTIVE',
    `Implement ${idea} completely as a maintainable application.`,
    'CONTEXT',
    'Inspect the repository first. If empty, scaffold a conventional project.',
    'REQUIREMENTS',
    '- Deliver the owner idea end-to-end',
    '- Keep the implementation maintainable and testable',
    'ARCHITECTURE',
    '- Use a conventional architecture for the inferred platform',
    'CONSTRAINTS',
    '- Do not ask the owner ordinary implementation questions',
    'SCOPE',
    '- Implement the complete first version including tests',
    'DO NOT',
    '- Do not disable tests or commit secrets',
    '- Do not skip acceptance criteria',
    'TESTING',
    '- Add and run unit tests appropriate to the stack',
    'REGRESSION',
    '- Preserve existing behavior when a repository already exists',
    'ACCEPTANCE',
    '- Core flows run; build and tests pass',
    'EVIDENCE',
    '- Return changed files, commands, build/test results, and unresolved issues'
  ].join('\n');
}

export function demoAnalysis(name = 'openai') {
  return {
    productInterpretation: { summary: 'Domain-appropriate application generated from the owner idea.', productType: 'application' },
    assumptions: ['The owner wants a complete first version without mid-loop questions'],
    targetUsers: ['Primary users described by the idea'],
    coreCapabilities: ['Implement the owner idea end-to-end', 'Verify core flows'],
    optionalCapabilities: ['Additional polish after the first complete version'],
    technicalConsiderations: ['Inspect any existing repository before changing architecture'],
    risks: ['Ambiguous visual branding'],
    unknowns: ['Exact third-party integrations'],
    recommendations: ['Favor a simple maintainable implementation'],
    architectureDirections: ['Choose a conventional architecture for the target platform'],
    testingConsiderations: ['Unit tests for core flows', 'Do not disable existing tests']
  };
}

export function demoCritique() {
  return {
    proposalAssessments: [
      { proposalId: 'Proposal A', strengths: ['Clear core capabilities'], weaknesses: ['Persistence details are thin'] },
      { proposalId: 'Proposal B', strengths: ['Sensible testing notes'], weaknesses: ['UX structure is implied'] }
    ],
    criticalFindings: [],
    missingRequirements: [],
    disagreements: [
      { topic: 'Wording of the product summary', category: 'wording', positions: ['shorter summary', 'longer summary'], material: false }
    ],
    recommendedDecisions: [
      { topic: 'architecture', decision: 'Keep a conventional maintainable architecture', rationale: 'Lowest risk for a first complete version' }
    ],
    confidence: { overall: 'medium' }
  };
}

function resolution() {
  return { resolutions: [{ topic: 'architecture', position: 'Conventional maintainable architecture', rationale: 'Fits the first version' }], remainingDisagreements: [] };
}

function architectureFromIdea(text) {
  const idea = String(text || '').toLowerCase();
  if (/\bios\b/.test(idea) && !/\bandroid\b/.test(idea)) {
    return { category: 'MOBILE', platform: 'IOS', framework: 'IOS', language: 'SWIFT', ui: true, backendRequired: false, databaseRequired: false, rationale: 'Owner explicitly requested iOS.' };
  }
  if (/\bflutter\b/.test(idea) || (/\bandroid\b/.test(idea) && /\bios\b/.test(idea))) {
    return { category: 'MOBILE', platform: 'CROSS_PLATFORM', framework: 'FLUTTER', language: 'DART', ui: true, backendRequired: false, databaseRequired: false, rationale: 'Cross-platform mobile request.' };
  }
  if (/\bandroid\b/.test(idea)) {
    return { category: 'MOBILE', platform: 'ANDROID', framework: 'ANDROID_NATIVE', language: 'KOTLIN', ui: true, backendRequired: false, databaseRequired: false, rationale: 'Owner requested an Android application.' };
  }
  if (/\bnext(?:\.js|js)?\b/.test(idea)) {
    return { category: 'FULL_STACK', platform: 'WEB', framework: 'NEXTJS', language: 'TYPESCRIPT', ui: true, backendRequired: true, databaseRequired: false, rationale: 'Server-rendered web application.' };
  }
  if (/\bapi\b|\bbackend\b/.test(idea) && !/\bweb\b/.test(idea)) {
    return { category: 'BACKEND', platform: 'SERVER', framework: 'NODE_BACKEND', language: 'TYPESCRIPT', ui: false, backendRequired: true, databaseRequired: false, rationale: 'Backend/API service.' };
  }
  return { category: 'WEB', platform: 'WEB', framework: 'VITE', language: 'TYPESCRIPT', ui: true, backendRequired: false, databaseRequired: false, rationale: 'Client-side web application.' };
}

function spec(prompt) {
  const idea = /Owner idea:\n([\s\S]*?)\n\nRepository context/.exec(prompt)?.[1]?.trim() || 'the owner idea';
  return {
    productName: 'Generated Application',
    productSummary: 'A domain-appropriate application generated from the owner idea.',
    projectType: 'application',
    product: { name: 'Generated Application', summary: 'A domain-appropriate application generated from the owner idea.', type: 'application', targetUsers: ['End users'] },
    requirements: { functional: ['Implement the owner idea end-to-end', 'Include tests and runtime verification'], nonFunctional: ['Maintainable structure', 'No secrets in source'] },
    assumptions: ['Council resolved ordinary engineering choices'],
    architecture: { platform: architectureFromIdea(idea).platform, technology: [architectureFromIdea(idea).framework], patterns: ['simple layered structure'], components: ['application core', 'tests'], data: { strategy: 'conventional' }, security: { secrets: 'do not commit' } },
    architectureChoice: architectureFromIdea(idea),
    ux: { principle: 'Direct and complete first version' },
    workPackages: [{ id: 'foundation', title: 'Implement complete application', acceptanceCriteria: ['Build succeeds', 'Tests pass', 'Core flows run'] }],
    acceptanceCriteria: ['Build succeeds', 'Tests pass', 'Core flows run'],
    testingStrategy: { unit: 'Cover core flows', integration: 'Where the stack supports it', regression: 'Preserve existing behavior' },
    risks: ['Visual polish may be incomplete without later visual QA'],
    decisions: [{ topic: 'architecture', choice: 'Conventional maintainable architecture', rationale: 'Technical merit and simplicity, not votes' }],
    cursorPrompt: demoCursorPrompt(idea)
  };
}

function memberReview(prompt) {
  const first = /Cursor run #1\b/.test(prompt);
  if (first) {
    return {
      decision: 'CHANGES_REQUIRED',
      findings: [{ severity: 'MEDIUM', category: 'completeness', issue: 'First pass needs an explicit correction cycle', evidence: 'Demo protocol requires one Cursor correction', requiredFix: 'Apply the correction prompt and retest' }],
      requirementsAssessment: ['Core idea is specified'],
      risks: [],
      confidence: { overall: 'medium' },
      summary: 'Demo review requests one correction cycle'
    };
  }
  return {
    decision: 'COMPLETE',
    findings: [],
    requirementsAssessment: ['Correction cycle completed'],
    risks: [],
    confidence: { overall: 'high' },
    summary: 'Demo review accepted after correction'
  };
}

function chairReview(prompt) {
  const first = /Cursor run #1\b/.test(prompt);
  if (first) {
    return {
      decision: 'CHANGES_REQUIRED',
      resolvedFindings: [],
      blockingFindings: [{ severity: 'MEDIUM', category: 'completeness', issue: 'Correction cycle required', evidence: 'First Cursor run is the demo baseline', requiredFix: 'Apply remaining demo correction work' }],
      nextCursorPrompt: 'Fix remaining completeness gaps from the first implementation pass. Keep existing behavior, run tests, and return evidence.',
      summary: 'Demo chair requires one correction cycle'
    };
  }
  return {
    decision: 'COMPLETE',
    resolvedFindings: [],
    blockingFindings: [],
    nextCursorPrompt: '',
    summary: 'Demo review accepted'
  };
}

function finalDecision() {
  return {
    decision: 'COMPLETE',
    blockingFindings: [],
    unresolvedPriorFindings: [],
    summary: 'Demo verification passed.',
    nextCursorPrompt: ''
  };
}

export class MockProvider extends ModelProvider {
  constructor(name, { visualDecision } = {}) {
    super({ name, model: 'mock', supportsVision: true });
    this.visualDecision = visualDecision || null;
  }
  async complete({ prompt, images } = {}) {
    if (prompt.includes('VISUAL_REVIEW_CHAIR')) return JSON.stringify(visualChair(prompt));
    if (prompt.includes('VISUAL_REVIEW')) return JSON.stringify(visualMember(prompt, images, this.visualDecision));
    if (prompt.includes('FINAL_VERIFICATION_DECISION')) return JSON.stringify(finalDecision());
    if (prompt.includes('IMPLEMENTATION_REVIEW_DECISION')) return JSON.stringify(chairReview(prompt));
    if (prompt.includes('IMPLEMENTATION_REVIEW')) return JSON.stringify(memberReview(prompt));
    if (prompt.includes('ARCHITECTURE_RESOLUTION')) return JSON.stringify(architectureFromIdea(prompt));
    if (prompt.includes('CHAIR_SYNTHESIS')) return JSON.stringify(spec(prompt));
    if (prompt.includes('COUNCIL_RESOLUTION')) return JSON.stringify(resolution());
    if (prompt.includes('CROSS_MODEL_CRITIQUE')) return JSON.stringify(demoCritique());
    if (prompt.includes('INDEPENDENT_PRODUCT_ANALYSIS')) return JSON.stringify(demoAnalysis(this.name));
    return JSON.stringify(demoAnalysis(this.name));
  }
}

function visualMember(prompt, images, forced) {
  const broken = forced === 'CHANGES_REQUIRED'
    || /CLIPPED|broken-visual|overflow|hidden form|mobile-only/i.test(prompt)
    || (images || []).some(image => /broken|clip|mobile/i.test(image.name || ''));
  if (broken) {
    return {
      screen: 'reviewed-screen',
      device: /MOBILE/.test(prompt) ? 'MOBILE' : 'DESKTOP',
      decision: 'CHANGES_REQUIRED',
      findings: [{
        severity: 'HIGH',
        category: 'clipping',
        description: 'A primary control is clipped or unusable in this viewport',
        evidence: 'Screenshot and layout context supplied to the visual reviewer',
        requiredFix: 'Keep the control fully visible and usable'
      }]
    };
  }
  return { screen: 'reviewed-screen', device: 'DESKTOP', decision: 'PASS', findings: [] };
}

function visualChair(prompt) {
  const hasBlocking = /"severity"\s*:\s*"(HIGH|CRITICAL)"/.test(prompt)
    || /"decision"\s*:\s*"CHANGES_REQUIRED"/.test(prompt);
  if (hasBlocking) {
    return {
      decision: 'CHANGES_REQUIRED',
      resolvedFindings: [],
      blockingFindings: [{
        severity: 'HIGH',
        category: 'clipping',
        description: 'Credible visual defect remains',
        evidence: 'At least one visual reviewer or deterministic layout check reported HIGH',
        requiredFix: 'Correct the clipped or broken UI'
      }],
      nextCursorPrompt: 'Fix the blocking visual defect. Do not break passing runtime scenarios or Phase 5 verification.',
      summary: 'Visual chair requires correction'
    };
  }
  return { decision: 'COMPLETE', resolvedFindings: [], blockingFindings: [], nextCursorPrompt: '', summary: 'No blocking visual findings' };
}

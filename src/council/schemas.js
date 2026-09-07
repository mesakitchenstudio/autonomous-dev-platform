const finding = {
  type: 'object',
  required: ['severity', 'category', 'issue', 'evidence', 'requiredFix'],
  properties: {
    severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    category: { type: 'string', minLength: 1 },
    issue: { type: 'string', minLength: 1 },
    evidence: { type: 'string', minLength: 1 },
    requiredFix: { type: 'string', minLength: 1 }
  }
};

const disagreement = {
  type: 'object',
  required: ['topic', 'category', 'positions', 'material'],
  properties: {
    topic: { type: 'string', minLength: 1 },
    category: { type: 'string', minLength: 1 },
    positions: { type: 'array', items: 'string' },
    material: { type: 'boolean' }
  }
};

export const analysisSchema = {
  type: 'object',
  required: ['productInterpretation', 'assumptions', 'targetUsers', 'coreCapabilities', 'optionalCapabilities', 'technicalConsiderations', 'risks', 'unknowns', 'recommendations', 'architectureDirections', 'testingConsiderations'],
  properties: {
    productInterpretation: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', minLength: 1 },
        productType: { type: 'string' }
      }
    },
    assumptions: { type: 'array', items: 'string' },
    targetUsers: { type: 'array', items: 'string' },
    coreCapabilities: { type: 'array', items: 'string', minItems: 1 },
    optionalCapabilities: { type: 'array', items: 'string' },
    technicalConsiderations: { type: 'array', items: 'string' },
    risks: { type: 'array', items: 'string' },
    unknowns: { type: 'array', items: 'string' },
    recommendations: { type: 'array', items: 'string' },
    architectureDirections: { type: 'array', items: 'string' },
    testingConsiderations: { type: 'array', items: 'string' }
  }
};

export const critiqueSchema = {
  type: 'object',
  required: ['proposalAssessments', 'criticalFindings', 'missingRequirements', 'disagreements', 'recommendedDecisions', 'confidence'],
  properties: {
    proposalAssessments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['proposalId', 'strengths', 'weaknesses'],
        properties: {
          proposalId: { type: 'string', minLength: 1 },
          strengths: { type: 'array', items: 'string' },
          weaknesses: { type: 'array', items: 'string' }
        }
      }
    },
    criticalFindings: { type: 'array', items: finding },
    missingRequirements: { type: 'array', items: 'string' },
    disagreements: { type: 'array', items: disagreement },
    recommendedDecisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['topic', 'decision', 'rationale'],
        properties: {
          topic: { type: 'string', minLength: 1 },
          decision: { type: 'string', minLength: 1 },
          rationale: { type: 'string', minLength: 1 }
        }
      }
    },
    confidence: {
      type: 'object',
      required: ['overall'],
      properties: { overall: { type: 'string', enum: ['high', 'medium', 'low'] } }
    }
  }
};

export const resolutionSchema = {
  type: 'object',
  required: ['resolutions', 'remainingDisagreements'],
  properties: {
    resolutions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['topic', 'position', 'rationale'],
        properties: {
          topic: { type: 'string', minLength: 1 },
          position: { type: 'string', minLength: 1 },
          rationale: { type: 'string', minLength: 1 }
        }
      }
    },
    remainingDisagreements: { type: 'array', items: disagreement }
  }
};

export const specificationSchema = {
  type: 'object',
  required: ['productName', 'productSummary', 'projectType', 'requirements', 'architecture', 'workPackages', 'acceptanceCriteria', 'testingStrategy', 'decisions', 'cursorPrompt'],
  properties: {
    productName: { type: 'string', minLength: 1 },
    productSummary: { type: 'string', minLength: 1 },
    projectType: { type: 'string', minLength: 1 },
    product: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        summary: { type: 'string' },
        type: { type: 'string' },
        targetUsers: { type: 'array', items: 'string' }
      }
    },
    requirements: {
      type: 'object',
      required: ['functional'],
      properties: {
        functional: { type: 'array', items: 'string', minItems: 1 },
        nonFunctional: { type: 'array', items: 'string' }
      }
    },
    assumptions: { type: 'array', items: 'string' },
    architecture: {
      type: 'object',
      required: ['platform', 'technology', 'components'],
      properties: {
        platform: { type: 'string', minLength: 1 },
        technology: { type: 'array', items: 'string' },
        patterns: { type: 'array', items: 'string' },
        components: { type: 'array', items: 'string', minItems: 1 },
        data: { type: 'object' },
        security: { type: 'object' }
      }
    },
    ux: { type: 'object' },
    workPackages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'acceptanceCriteria'],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          acceptanceCriteria: { type: 'array', items: 'string', minItems: 1 }
        }
      }
    },
    acceptanceCriteria: { type: 'array', items: 'string', minItems: 1 },
    testingStrategy: {
      type: 'object',
      required: ['unit'],
      properties: {
        unit: { type: 'string', minLength: 1 },
        integration: { type: 'string' },
        regression: { type: 'string' }
      }
    },
    risks: { type: 'array', items: 'string' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['topic', 'choice', 'rationale'],
        properties: {
          topic: { type: 'string', minLength: 1 },
          choice: { type: 'string', minLength: 1 },
          rationale: { type: 'string', minLength: 1 }
        }
      }
    },
    cursorPrompt: { type: 'string', minLength: 40 },
    architectureChoice: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        platform: { type: 'string' },
        framework: { type: 'string' },
        language: { type: 'string' },
        ui: { type: 'boolean' },
        backendRequired: { type: 'boolean' },
        databaseRequired: { type: 'boolean' },
        rationale: { type: 'string' }
      }
    }
  }
};

export const architectureChoiceSchema = {
  type: 'object',
  required: ['category', 'platform', 'framework', 'language', 'rationale'],
  properties: {
    category: { type: 'string', enum: ['WEB', 'MOBILE', 'BACKEND', 'DESKTOP', 'CLI', 'FULL_STACK', 'MULTI_APP'] },
    platform: { type: 'string', enum: ['WEB', 'ANDROID', 'IOS', 'CROSS_PLATFORM', 'SERVER', 'DESKTOP'] },
    framework: { type: 'string', minLength: 1 },
    language: { type: 'string', minLength: 1 },
    ui: { type: 'boolean' },
    backendRequired: { type: 'boolean' },
    databaseRequired: { type: 'boolean' },
    rationale: { type: 'string', minLength: 1 }
  }
};

export const reviewSchema = {
  type: 'object',
  required: ['decision', 'findings', 'requirementsAssessment', 'risks', 'confidence'],
  properties: {
    decision: { type: 'string', enum: ['COMPLETE', 'CHANGES_REQUIRED'] },
    findings: { type: 'array', items: finding },
    requirementsAssessment: { type: 'array', items: 'string' },
    risks: { type: 'array', items: 'string' },
    confidence: {
      type: 'object',
      required: ['overall'],
      properties: { overall: { type: 'string', enum: ['high', 'medium', 'low'] } }
    },
    summary: { type: 'string' }
  }
};

export const reviewChairSchema = {
  type: 'object',
  required: ['decision', 'resolvedFindings', 'blockingFindings', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['COMPLETE', 'CHANGES_REQUIRED'] },
    resolvedFindings: { type: 'array', items: finding },
    blockingFindings: { type: 'array', items: finding },
    nextCursorPrompt: { type: 'string' },
    summary: { type: 'string', minLength: 1 }
  }
};

export const finalReviewSchema = {
  type: 'object',
  required: ['decision', 'blockingFindings', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['COMPLETE', 'CHANGES_REQUIRED'] },
    blockingFindings: { type: 'array', items: finding },
    unresolvedPriorFindings: { type: 'array', items: finding },
    summary: { type: 'string', minLength: 1 },
    nextCursorPrompt: { type: 'string' }
  }
};

export const HIGH_SEVERITY = new Set(['CRITICAL', 'HIGH']);

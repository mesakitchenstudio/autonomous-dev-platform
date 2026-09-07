export const VISUAL_CATEGORIES = Object.freeze([
  'clipping', 'overlap', 'truncation', 'broken_layout', 'missing_content', 'unreadable_text',
  'contrast', 'inconsistent_spacing', 'blank_area', 'malformed_control', 'broken_responsive_layout',
  'loading_error_state', 'visual_hierarchy', 'accessibility', 'inconsistent_design',
  'broken_image', 'navigation_state'
]);

export const visualFindingSchema = {
  type: 'object',
  required: ['severity', 'category', 'description', 'evidence', 'requiredFix'],
  properties: {
    severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    category: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    evidence: { type: 'string', minLength: 1 },
    requiredFix: { type: 'string', minLength: 1 },
    region: { type: 'object' }
  }
};

export const visualReviewSchema = {
  type: 'object',
  required: ['screen', 'device', 'decision', 'findings'],
  properties: {
    screen: { type: 'string', minLength: 1 },
    device: { type: 'string', minLength: 1 },
    decision: { type: 'string', enum: ['PASS', 'CHANGES_REQUIRED'] },
    findings: { type: 'array', items: visualFindingSchema }
  }
};

export const visualChairSchema = {
  type: 'object',
  required: ['decision', 'blockingFindings', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['COMPLETE', 'CHANGES_REQUIRED'] },
    resolvedFindings: { type: 'array', items: visualFindingSchema },
    blockingFindings: { type: 'array', items: visualFindingSchema },
    nextCursorPrompt: { type: 'string' },
    summary: { type: 'string', minLength: 1 }
  }
};

export function visualReviewPrompt({ spec, acceptance, screen, viewport, diagnostics, priorFindings, checkpointSha }) {
  return `VISUAL_REVIEW
Product specification:
${JSON.stringify(spec || {})}

Acceptance criteria:
${JSON.stringify(acceptance || [])}

Screen purpose:
${screen}

Viewport / device:
${JSON.stringify(viewport || {})}

Runtime checkpoint SHA:
${checkpointSha || 'unknown'}

Runtime diagnostics:
${JSON.stringify(diagnostics || {})}

Prior visual findings:
${JSON.stringify(priorFindings || [])}

Review for clipping, overlap, truncation, broken layout, missing content, unreadable text, contrast, inconsistent spacing, blank areas, malformed controls, broken responsive layout, loading/error-state defects, visual hierarchy, obvious accessibility issues, inconsistent design, broken images/icons, and navigation/state inconsistency.
Do not invent coordinates if you cannot reliably locate a region.
Return JSON:
{"screen":"...","device":"...","decision":"PASS|CHANGES_REQUIRED","findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","category":"...","description":"...","evidence":"...","requiredFix":"...","region":{}}]}`;
}

export function visualChairPrompt(reviews, extras = {}) {
  return `VISUAL_REVIEW_CHAIR
Independent visual reviews:
${JSON.stringify(reviews)}

Deterministic layout findings:
${JSON.stringify(extras.layoutFindings || [])}

Do not majority-vote. A single credible HIGH or CRITICAL visual defect must not be ignored because other reviewers missed it. If you dismiss a HIGH/CRITICAL finding, put it in resolvedFindings with rationale.
Return JSON:
{"decision":"COMPLETE|CHANGES_REQUIRED","resolvedFindings":[],"blockingFindings":[],"nextCursorPrompt":"","summary":"..."}`;
}

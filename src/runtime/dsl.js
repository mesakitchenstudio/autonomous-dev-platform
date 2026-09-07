const ACTIONS = new Set([
  'NAVIGATE', 'CLICK', 'FILL', 'SELECT', 'CHECK', 'PRESS',
  'WAIT_FOR', 'ASSERT_VISIBLE', 'ASSERT_TEXT', 'ASSERT_URL', 'SCREENSHOT',
  'KEYBOARD_TAB', 'KEYBOARD_ENTER', 'HTTP'
]);

const FORBIDDEN_SELECTOR = /javascript:|data:text\/html|file:|eval\(|document\.|window\.|__proto__/i;

export function validateAction(step, { baseUrl = null } = {}) {
  if (!step || typeof step !== 'object') return { ok: false, error: 'Action must be an object' };
  const action = String(step.action || '').toUpperCase();
  if (!ACTIONS.has(action)) return { ok: false, error: `Unsupported action: ${step.action || '(missing)'}` };
  if (step.selector && (typeof step.selector !== 'string' || FORBIDDEN_SELECTOR.test(step.selector))) {
    return { ok: false, error: 'Selector is missing or not bounded to the application under test' };
  }
  if (action === 'NAVIGATE') {
    const url = String(step.url || '');
    if (!url) return { ok: false, error: 'NAVIGATE requires url' };
    if (/^https?:\/\//i.test(url) && baseUrl && !url.startsWith(baseUrl)) {
      return { ok: false, error: 'NAVIGATE url is outside the application under test' };
    }
    if (/^(file|javascript|data):/i.test(url)) return { ok: false, error: 'NAVIGATE url scheme is not allowed' };
  }
  if (['CLICK', 'FILL', 'SELECT', 'CHECK', 'ASSERT_VISIBLE', 'ASSERT_TEXT'].includes(action) && !step.selector) {
    return { ok: false, error: `${action} requires a selector` };
  }
  if (action === 'HTTP') {
    const method = String(step.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return { ok: false, error: 'HTTP method is not allowed' };
    }
    if (!step.url) return { ok: false, error: 'HTTP requires url' };
  }
  return { ok: true, action: { ...step, action } };
}

export function validateScenario(scenario, options = {}) {
  if (!scenario?.id || !scenario.goal) return { ok: false, error: 'Scenario requires id and goal' };
  const steps = [];
  for (const [index, raw] of (scenario.steps || []).entries()) {
    const checked = validateAction(raw, options);
    if (!checked.ok) return { ok: false, error: `Step ${index}: ${checked.error}` };
    steps.push(checked.action);
  }
  return {
    ok: true,
    scenario: {
      id: String(scenario.id),
      goal: String(scenario.goal),
      preconditions: Array.isArray(scenario.preconditions) ? scenario.preconditions : [],
      steps,
      expectedOutcomes: Array.isArray(scenario.expectedOutcomes) ? scenario.expectedOutcomes : [],
      priority: scenario.priority || 'MEDIUM',
      requiresAuth: Boolean(scenario.requiresAuth),
      requiresTestData: Boolean(scenario.requiresTestData)
    }
  };
}

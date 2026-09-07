import { intEnv } from '../util/env.js';
import { ScenarioPriority } from './kinds.js';
import { validateScenario } from './dsl.js';

const MAX_DEFAULT = 8;

export function planScenarios({ spec = {}, applicationKind, detectedRoutes = [], extra = [] } = {}) {
  const max = intEnv('RUNTIME_MAX_SCENARIOS', MAX_DEFAULT);
  const raw = [];
  if (applicationKind === 'WEB_UI') {
    raw.push({
      id: 'home-load',
      goal: 'User can open the application home screen',
      priority: ScenarioPriority.CRITICAL,
      steps: [
        { action: 'NAVIGATE', url: detectedRoutes[0] || '/' },
        { action: 'WAIT_FOR', condition: 'load' },
        { action: 'ASSERT_VISIBLE', selector: 'body' },
        { action: 'SCREENSHOT', name: 'home' }
      ],
      expectedOutcomes: ['Home screen is visible']
    });
    raw.push({
      id: 'primary-interaction',
      goal: firstInteractiveGoal(spec) || 'User can complete a primary on-screen action',
      priority: ScenarioPriority.CRITICAL,
      steps: [
        { action: 'NAVIGATE', url: '/' },
        { action: 'WAIT_FOR', condition: 'load' },
        { action: 'CLICK', selector: 'button, [role="button"], input[type="submit"], a[href]' },
        { action: 'SCREENSHOT', name: 'after-primary-action' }
      ],
      expectedOutcomes: ['Primary control is usable']
    });
  } else if (applicationKind === 'BACKEND') {
    raw.push({
      id: 'health-smoke',
      goal: 'Service responds to a readiness/health request',
      priority: ScenarioPriority.CRITICAL,
      steps: [{ action: 'HTTP', method: 'GET', url: '/health', acceptStatus: [200, 204, 404] }],
      expectedOutcomes: ['Process is reachable over HTTP']
    });
  } else if (applicationKind === 'CLI') {
    raw.push({
      id: 'cli-help',
      goal: 'CLI entry command exits successfully',
      priority: ScenarioPriority.CRITICAL,
      steps: [{ action: 'ASSERT_TEXT', selector: 'stdout', text: '' }],
      expectedOutcomes: ['Command exits 0']
    });
  } else if (applicationKind === 'ANDROID' || applicationKind === 'IOS') {
    raw.push({
      id: 'app-launch',
      goal: 'Application launches without an immediate crash',
      priority: ScenarioPriority.CRITICAL,
      steps: [{ action: 'WAIT_FOR', condition: 'launch' }, { action: 'SCREENSHOT', name: 'launch' }],
      expectedOutcomes: ['Process remains alive']
    });
  }
  for (const item of extra) raw.push(item);
  const scenarios = [];
  for (const item of raw) {
    const checked = validateScenario(item);
    if (checked.ok) scenarios.push(checked.scenario);
  }
  scenarios.sort((a, b) => rank(a.priority) - rank(b.priority));
  return scenarios.slice(0, max);
}

export function sanitizeCouncilScenarios(raw, options = {}) {
  const max = intEnv('RUNTIME_MAX_SCENARIOS', MAX_DEFAULT);
  const out = [];
  for (const item of raw || []) {
    const checked = validateScenario(item, options);
    if (checked.ok) out.push(checked.scenario);
    if (out.length >= max) break;
  }
  return out;
}

function firstInteractiveGoal(spec) {
  const criteria = [
    ...(spec.acceptanceCriteria || []),
    ...(spec.requirements?.functional || []),
    ...(spec.workPackages || []).flatMap(item => item.acceptanceCriteria || [])
  ].map(String);
  return criteria.find(item => /save|submit|search|login|create|add|favorite|open/i.test(item)) || criteria[0] || null;
}

function rank(priority) {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[priority] ?? 4;
}

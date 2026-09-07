import { PolicyLevel } from '../verify/kinds.js';
import { WorkerCapability } from '../capabilities/kinds.js';
import { ApplicationKind, DEFAULT_VIEWPORTS, RuntimeAdapterName, WEB_BROWSER_POLICY } from './kinds.js';
import { detectApplicationKind, detectHealthPath, detectLaunchCommand } from './detect.js';
import { planScenarios } from './scenarios.js';
import { validateScenario } from './dsl.js';

function validateIfNeeded(item) {
  const checked = validateScenario(item);
  return checked.ok ? checked.scenario : null;
}
import { latestCursorRun } from '../orchestrator/gate.js';
import { validateRuntimePlanSecurity, validateNetworkRequestPlan } from '../security/ai-policy.js';

export async function createRuntimePlan(workspacePath, project = {}, extras = {}) {
  const detected = extras.detected || await detectApplicationKind(workspacePath, project);
  const launch = extras.launch || (detected.applicationKind === ApplicationKind.WEB_UI || detected.applicationKind === ApplicationKind.BACKEND
    ? await detectLaunchCommand(workspacePath)
    : null);
  const healthPath = extras.healthPath || await detectHealthPath(workspacePath);
  const scenarios = extras.scenarios
    || (extras.extraScenarios?.length
      ? extras.extraScenarios.map(item => validateIfNeeded(item)).filter(Boolean)
      : planScenarios({
        spec: project.council?.discovery?.spec || {},
        applicationKind: detected.applicationKind,
        extra: []
      }));
  const visualRequired = Boolean(detected.visual) && detected.applicationKind !== ApplicationKind.BACKEND && detected.applicationKind !== ApplicationKind.CLI;
  const runtimeRequired = detected.applicationKind !== ApplicationKind.UNKNOWN && detected.applicationKind !== ApplicationKind.GENERIC
    ? PolicyLevel.REQUIRED
    : PolicyLevel.NOT_APPLICABLE;
  const last = latestCursorRun(project);
  const artifact = (project.verificationRuns || []).at(-1)?.artifacts?.find(item => item.sha256 && (item.kind === 'build_output' || item.type === 'build_output'));
  const plan = {
    applicationKind: detected.applicationKind,
    runtimeAdapter: detected.runtimeAdapter || RuntimeAdapterName.GENERIC,
    visualRequired,
    launch: {
      command: launch?.command || [],
      script: launch?.script || null,
      source: launch?.source || null,
      healthCheck: { path: healthPath, method: 'GET' },
      timeoutMs: extras.timeoutMs || 30000
    },
    scenarios,
    viewports: visualRequired ? [DEFAULT_VIEWPORTS.DESKTOP, DEFAULT_VIEWPORTS.MOBILE] : [],
    browsers: detected.applicationKind === ApplicationKind.WEB_UI ? { ...WEB_BROWSER_POLICY } : {},
    accessibility: visualRequired ? { required: true, claim: 'AUTOMATED_ACCESSIBILITY_CHECKS' } : { required: false },
    visualReview: { required: visualRequired },
    policy: {
      runtime: launch || detected.applicationKind === ApplicationKind.CLI || detected.applicationKind === ApplicationKind.BACKEND
        ? runtimeRequired
        : (detected.applicationKind === ApplicationKind.UNKNOWN ? PolicyLevel.NOT_APPLICABLE : runtimeRequired),
      visual: visualRequired ? PolicyLevel.REQUIRED : PolicyLevel.NOT_APPLICABLE,
      accessibility: visualRequired ? PolicyLevel.REQUIRED : PolicyLevel.NOT_APPLICABLE,
      functional: runtimeRequired
    },
    requiredCapabilities: capabilitiesFor(detected),
    checkpointSha: last?.checkpointSha || last?.git?.checkpointSha || last?.git?.afterSha || null,
    artifactHash: artifact?.sha256 || extras.artifactHash || null
  };
  validateRuntimePlanSecurity(plan);
  validateNetworkRequestPlan(plan);
  return plan;
}

function capabilitiesFor(detected) {
  if (detected.applicationKind === ApplicationKind.WEB_UI) return [WorkerCapability.WEB_CHROMIUM];
  if (detected.applicationKind === ApplicationKind.ANDROID) return [WorkerCapability.ANDROID_SDK, WorkerCapability.ANDROID_EMULATOR];
  if (detected.applicationKind === ApplicationKind.IOS) return [WorkerCapability.MACOS, WorkerCapability.IOS_SIMULATOR];
  return [];
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { Council, assertReviewChairDecision, assertFinalDecision, normalizeSpecification } from '../src/council/council.js';
import { MockProvider, demoAnalysis, demoCritique, demoCursorPrompt } from '../src/providers/mock.js';
import { anonymizeAnalyses } from '../src/council/anonymize.js';
import { shouldRunResolution, collectMaterialDisagreements } from '../src/council/disagreement.js';
import { assertCursorPromptContract, missingCursorPromptSections } from '../src/council/cursor-contract.js';
import { validateObject } from '../src/council/validate.js';
import { analysisSchema, reviewChairSchema } from '../src/council/schemas.js';
import { ErrorCode } from '../src/orchestrator/errors.js';
import { tempStore } from './helpers.js';

const noRetry = { maxRetries: 0, sleep: async () => {}, random: () => 0 };

function council(providers, chairName = 'openai', extra = {}) {
  return new Council(providers, chairName, {
    retryPolicy: noRetry,
    minResponses: Math.min(2, providers.length),
    ...extra
  });
}

test('Round 1 analyses are independent and do not include other model responses', async () => {
  const seen = [];
  const make = name => {
    const mock = new MockProvider(name);
    return {
      name,
      model: 'mock',
      async complete(request) {
        seen.push({ name, prompt: request.prompt });
        return mock.complete(request);
      }
    };
  };
  const c = council([make('openai'), make('anthropic')]);
  await c.discover('Build a pantry tracker');
  const round1 = seen.filter(item => item.prompt.includes('INDEPENDENT_PRODUCT_ANALYSIS') && !item.prompt.includes('RESPONSE_REPAIR'));
  assert.equal(round1.length, 2);
  for (const item of round1) {
    assert.doesNotMatch(item.prompt, /anthropic|openai|claude|gemini|grok/i);
    assert.doesNotMatch(item.prompt, /Proposal [A-D]/);
  }
});

test('critique proposals are anonymized and all valid proposals reach reviewers', async () => {
  const seen = [];
  const make = name => {
    const mock = new MockProvider(name);
    return {
      name,
      model: 'mock',
      async complete(request) {
        seen.push(request.prompt);
        return mock.complete(request);
      }
    };
  };
  await council([make('openai'), make('anthropic')]).discover('idea');
  const critique = seen.find(prompt => prompt.includes('CROSS_MODEL_CRITIQUE') && !prompt.includes('RESPONSE_REPAIR'));
  assert.match(critique, /Proposal A/);
  assert.match(critique, /Proposal B/);
  assert.doesNotMatch(critique, /openai|anthropic|claude|gemini|grok/i);
});

test('malformed response triggers bounded repair then cannot silently continue', async () => {
  let analysisCalls = 0;
  const flaky = {
    name: 'openai',
    model: 'm',
    async complete({ prompt }) {
      if (prompt.includes('INDEPENDENT_PRODUCT_ANALYSIS')) {
        analysisCalls += 1;
        if (!prompt.includes('RESPONSE_REPAIR')) return 'not-json';
      }
      return new MockProvider('openai').complete({ prompt });
    }
  };
  const c = council([flaky, new MockProvider('anthropic')], 'anthropic', { maxRepairAttempts: 1 });
  const out = await c.discover('idea');
  assert.ok(analysisCalls >= 2);
  assert.equal(out.analyses.length, 2);
});

test('invalid response cannot silently enter Council reasoning', async () => {
  const bad = { name: 'openai', model: 'm', async complete() { return 'still-bad'; } };
  const c = council([bad, { name: 'anthropic', model: 'm', async complete() { return 'also-bad'; } }], 'openai', { maxRepairAttempts: 1 });
  await assert.rejects(() => c.discover('idea'), err => err.code === ErrorCode.ALL_PROVIDERS_FAILED || err.code === ErrorCode.INVALID_RESPONSE);
});

test('one reviewer failure is tolerated during critique', async () => {
  const failingCritique = {
    name: 'gemini',
    model: 'm',
    async complete({ prompt }) {
      if (prompt.includes('CROSS_MODEL_CRITIQUE')) throw new Error('critique down');
      return new MockProvider('gemini').complete({ prompt });
    }
  };
  const out = await council([new MockProvider('openai'), new MockProvider('anthropic'), failingCritique], 'openai').discover('idea');
  assert.ok(out.failures.some(item => item.provider === 'gemini'));
  assert.ok(out.spec.cursorPrompt);
});

test('trivial wording disagreement does not create a resolution round', () => {
  const critiques = [{ normalized: demoCritique() }];
  assert.equal(collectMaterialDisagreements(critiques).length, 0);
  assert.equal(shouldRunResolution(critiques, { currentRounds: 2, maxRounds: 3 }), false);
});

test('material disagreement can trigger resolution but respects the round limit', () => {
  const critiques = [{
    normalized: {
      disagreements: [{ topic: 'Use Postgres vs SQLite', category: 'persistence', positions: ['postgres', 'sqlite'], material: true }]
    }
  }];
  assert.equal(shouldRunResolution(critiques, { currentRounds: 2, maxRounds: 3 }), true);
  assert.equal(shouldRunResolution(critiques, { currentRounds: 3, maxRounds: 3 }), false);
});

test('Chair provider and model are independently configurable', () => {
  const anthropic = new MockProvider('anthropic');
  const chair = anthropic.withModel('claude-chair-test');
  const c = council([new MockProvider('openai'), anthropic], 'anthropic', { chair });
  assert.equal(c.chair.name, 'anthropic');
  assert.equal(c.chair.model, 'claude-chair-test');
  assert.equal(anthropic.model, 'mock');
});

test('invalid Chair specification fails safely', async () => {
  const chair = {
    name: 'openai',
    model: 'chair',
    async complete({ prompt }) {
      if (prompt.includes('CHAIR_SYNTHESIS')) return JSON.stringify({ productName: 'X' });
      return new MockProvider('openai').complete({ prompt });
    }
  };
  const c = council([new MockProvider('anthropic'), chair], 'openai', { chair, maxRepairAttempts: 0 });
  await assert.rejects(() => c.discover('idea'), err => err.code === ErrorCode.CHAIR_FAILURE);
});

test('majority does not override a valid HIGH minority finding', () => {
  const reviews = [
    { normalized: { findings: [] } },
    { normalized: { findings: [] } },
    { normalized: { findings: [] } },
    { normalized: { findings: [{ severity: 'HIGH', category: 'security', issue: 'secrets committed', evidence: 'diff', requiredFix: 'remove secrets' }] } }
  ];
  assert.throws(() => assertReviewChairDecision({
    decision: 'COMPLETE',
    resolvedFindings: [],
    blockingFindings: [],
    nextCursorPrompt: '',
    summary: 'majority said complete'
  }, reviews));
});

test('CHANGES_REQUIRED requires nextCursorPrompt and COMPLETE cannot keep blocking highs', () => {
  assert.throws(() => assertReviewChairDecision({
    decision: 'CHANGES_REQUIRED',
    resolvedFindings: [],
    blockingFindings: [],
    nextCursorPrompt: '',
    summary: 'fix it'
  }, []));
  assert.throws(() => assertReviewChairDecision({
    decision: 'COMPLETE',
    resolvedFindings: [],
    blockingFindings: [{ severity: 'HIGH', category: 'security', issue: 'x', evidence: 'y', requiredFix: 'z' }],
    nextCursorPrompt: '',
    summary: 'no'
  }, []));
  assert.throws(() => assertFinalDecision({
    decision: 'COMPLETE',
    blockingFindings: [{ severity: 'CRITICAL', category: 'security', issue: 'x', evidence: 'y', requiredFix: 'z' }],
    summary: 'no',
    nextCursorPrompt: ''
  }));
});

test('Cursor prompt contract requires implementation sections', () => {
  assert.ok(missingCursorPromptSections('do some work').includes('OBJECTIVE'));
  assert.doesNotThrow(() => assertCursorPromptContract(demoCursorPrompt('cook')));
});

test('analysis schema rejects missing required fields', () => {
  const result = validateObject(analysisSchema, { recommendations: [] });
  assert.equal(result.ok, false);
});

test('review chair schema validates decision enums', () => {
  const result = validateObject(reviewChairSchema, {
    decision: 'MAYBE',
    resolvedFindings: [],
    blockingFindings: [],
    nextCursorPrompt: '',
    summary: 'x'
  });
  assert.equal(result.ok, false);
});

test('anonymize mapping stays private from proposal payloads', () => {
  const { proposals, mapping } = anonymizeAnalyses([
    { provider: 'openai', normalized: demoAnalysis('openai') },
    { provider: 'anthropic', normalized: demoAnalysis('anthropic') }
  ]);
  assert.equal(mapping['Proposal A'], 'openai');
  assert.equal(proposals[0].id, 'Proposal A');
  assert.equal(JSON.stringify(proposals).includes('openai'), false);
});

test('Council history and usage survive store reload', async () => {
  const { store } = await tempStore();
  const c = council(['openai', 'anthropic'].map(name => new MockProvider(name)));
  const discovery = await c.discover('idea');
  const project = await store.create({ idea: 'idea' });
  project.council.discovery = discovery;
  await store.save(project);
  const reloaded = await store.get(project.id);
  assert.ok(reloaded.council.discovery.history.length >= 3);
  assert.equal(reloaded.council.discovery.spec.productName, 'Generated Application');
  assert.ok(reloaded.council.discovery.participation.chair.provider);
  assert.ok(reloaded.council.discovery.history.some(round => round.purpose === 'chair_synthesis' && round.chair?.provider));
  assert.ok(reloaded.council.discovery.history.every(round => Array.isArray(round.participants)));
  assert.ok(reloaded.council.discovery.history.some(round => round.participants.some(item => item.usage === null || item.usage)));
});

test('demo review performs one CHANGES_REQUIRED cycle then COMPLETE', async () => {
  const c = council(['openai', 'anthropic'].map(name => new MockProvider(name)));
  const spec = (await c.discover('idea')).spec;
  const first = await c.review({ idea: 'idea', spec, cursorResult: { output: 'first' }, iteration: 1 });
  assert.equal(first.decision.decision, 'CHANGES_REQUIRED');
  assert.ok(first.decision.nextCursorPrompt.trim());
  const second = await c.review({ idea: 'idea', spec, cursorResult: { output: 'second' }, iteration: 2 });
  assert.equal(second.decision.decision, 'COMPLETE');
  assert.equal(second.decision.blockingFindings.length, 0);
  const final = await c.finalVerify({ idea: 'idea', spec, cursorRuns: [{ iteration: 1 }, { iteration: 2 }] });
  assert.equal(final.decision.decision, 'COMPLETE');
});

test('normalizeSpecification keeps Phase 1 productName compatibility', () => {
  const spec = normalizeSpecification({
    productName: 'App',
    productSummary: 's',
    projectType: 'web',
    cursorPrompt: demoCursorPrompt('x')
  });
  assert.equal(spec.product.name, 'App');
});

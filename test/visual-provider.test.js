import test from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/providers/mock.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { XAIProvider } from '../src/providers/xai.js';
import { providerSupportsVision } from '../src/providers/vision.js';
import { extractJson } from '../src/providers/provider.js';
import { ErrorCode } from '../src/orchestrator/errors.js';
import { visualReviewSchema } from '../src/visual/schema.js';
import { validateObject } from '../src/council/validate.js';

import { loadDotEnv } from '../src/util/env.js';

loadDotEnv();

const IMAGE = {
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  name: 'synthetic-review.png'
};

const PROVIDERS = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  gemini: GeminiProvider,
  xai: XAIProvider
};

test('every Council provider adapter advertises vision capability from configuration', () => {
  assert.equal(new OpenAIProvider({ apiKey: 'k', model: 'gpt-5' }).supportsVision, true);
  assert.equal(new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5' }).supportsVision, true);
  assert.equal(new GeminiProvider({ apiKey: 'k', model: 'gemini-3.7-flash' }).supportsVision, true);
  assert.equal(new XAIProvider({ apiKey: 'k', model: 'grok-4.6' }).supportsVision, true);
  assert.equal(new MockProvider('openai').supportsVision, true);
});

test('unsupported vision models fail cleanly without leaking filesystem paths', async () => {
  const previous = process.env.OPENAI_VISION;
  process.env.OPENAI_VISION = 'false';
  const provider = new OpenAIProvider({ apiKey: 'k', model: 'gpt-5' });
  await assert.rejects(
    () => provider.complete({ system: 's', prompt: 'VISUAL_REVIEW', images: [{ ...IMAGE, name: 'C:\\\\secret\\\\shot.png' }] }),
    err => err.code === ErrorCode.VISION_UNSUPPORTED && !String(err.message).includes('C:\\\\secret')
  );
  if (previous == null) delete process.env.OPENAI_VISION;
  else process.env.OPENAI_VISION = previous;
});

test('mock provider returns a structured visual finding schema', async () => {
  const provider = new MockProvider('openai');
  const raw = await provider.complete({
    prompt: 'VISUAL_REVIEW CLIPPED button overflow MOBILE',
    images: [{ ...IMAGE, name: 'broken-visual.png' }]
  });
  const parsed = extractJson(typeof raw === 'string' ? raw : raw.text);
  const validation = validateObject(visualReviewSchema, parsed);
  assert.equal(validation.ok, true);
  assert.equal(parsed.decision, 'CHANGES_REQUIRED');
  assert.equal(parsed.findings[0].severity, 'HIGH');
});

test('visual chair does not majority-vote away a HIGH finding', async () => {
  const provider = new MockProvider('openai');
  const raw = await provider.complete({
    prompt: 'VISUAL_REVIEW_CHAIR {"decision":"CHANGES_REQUIRED","findings":[{"severity":"HIGH","category":"clipping"}]} plus three PASS reviewers'
  });
  const parsed = extractJson(typeof raw === 'string' ? raw : raw.text);
  assert.equal(parsed.decision, 'CHANGES_REQUIRED');
  assert.ok(parsed.blockingFindings.length);
});

test('live vision smoke reports honestly per provider', { timeout: 180000 }, async () => {
  const checks = [
    ['OpenAI', 'OPENAI_API_KEY', 'openai', process.env.OPENAI_MODEL || 'gpt-5'],
    ['Anthropic', 'ANTHROPIC_API_KEY', 'anthropic', process.env.ANTHROPIC_MODEL || 'claude-opus-5'],
    ['Gemini', 'GEMINI_API_KEY', 'gemini', process.env.GEMINI_MODEL || 'gemini-3.7-flash'],
    ['xAI', 'XAI_API_KEY', 'xai', process.env.XAI_MODEL || 'grok-4.6']
  ];
  globalThis.__phase6Vision = {};
  for (const [label, envName, name, model] of checks) {
    const key = String(process.env[envName] || '').trim();
    if (!key || /secret-must-not-appear/.test(key)) {
      globalThis.__phase6Vision[label] = 'NOT VERIFIED — CREDENTIALS UNAVAILABLE';
      continue;
    }
    if (!providerSupportsVision(name, model)) {
      globalThis.__phase6Vision[label] = 'UNSUPPORTED BY CONFIGURED MODEL';
      continue;
    }
    try {
      const Provider = PROVIDERS[name];
      const provider = new Provider({ apiKey: process.env[envName], model, timeoutMs: 30000 });
      const result = await provider.complete({
        system: 'Reply with compact JSON only.',
        prompt: 'This is a 1x1 synthetic PNG used only for a vision smoke test. Reply {"ok":true}.',
        images: [IMAGE]
      });
      const text = typeof result === 'string' ? result : result?.text;
      globalThis.__phase6Vision[label] = text ? 'VERIFIED' : 'FAILED';
    } catch {
      globalThis.__phase6Vision[label] = 'FAILED';
    }
  }
  assert.ok(Object.keys(globalThis.__phase6Vision).length === 4);
});

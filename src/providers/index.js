import { boolEnv } from '../util/env.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { XAIProvider } from './xai.js';
import { MockProvider } from './mock.js';
import { resolveModelName } from './config.js';

export const LIVE_PROVIDER_DEFS = Object.freeze([
  { name: 'openai', key: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', fallbackModel: 'gpt-5', Provider: OpenAIProvider },
  { name: 'anthropic', key: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', fallbackModel: 'claude-opus-5', Provider: AnthropicProvider },
  { name: 'gemini', key: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', fallbackModel: 'gemini-3.7-flash', Provider: GeminiProvider },
  { name: 'xai', key: 'XAI_API_KEY', modelEnv: 'XAI_MODEL', fallbackModel: 'grok-4.6', Provider: XAIProvider }
]);

export function createLiveProviders(env = process.env, { timeoutMs } = {}) {
  return LIVE_PROVIDER_DEFS.filter(def => env?.[def.key] && String(env[def.key]).trim()).map(def => new def.Provider({
    apiKey: env[def.key],
    model: resolveModelName(def.modelEnv, def.fallbackModel, env),
    timeoutMs
  }));
}

export function createProviders() {
  if (boolEnv('DEMO_MODE', false)) return [new MockProvider('openai'), new MockProvider('anthropic'), new MockProvider('gemini'), new MockProvider('xai')];
  const providers = createLiveProviders(process.env);
  const strict = boolEnv('STRICT_COUNCIL', true);
  if (strict && providers.length !== 4) throw new Error('STRICT_COUNCIL=true requires OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, and XAI_API_KEY.');
  if (!providers.length) throw new Error('No AI providers configured. Add API keys or set DEMO_MODE=true.');
  return providers;
}

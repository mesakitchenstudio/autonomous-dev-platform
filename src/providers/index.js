import { boolEnv } from '../util/env.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { XAIProvider } from './xai.js';
import { MockProvider } from './mock.js';
import { resolveModelName } from './config.js';

export function createProviders() {
  if (boolEnv('DEMO_MODE', false)) return [new MockProvider('openai'), new MockProvider('anthropic'), new MockProvider('gemini'), new MockProvider('xai')];
  const defs = [
    ['OPENAI_API_KEY', () => new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: resolveModelName('OPENAI_MODEL', 'gpt-5') })],
    ['ANTHROPIC_API_KEY', () => new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: resolveModelName('ANTHROPIC_MODEL', 'claude-opus-5') })],
    ['GEMINI_API_KEY', () => new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: resolveModelName('GEMINI_MODEL', 'gemini-3.7-flash') })],
    ['XAI_API_KEY', () => new XAIProvider({ apiKey: process.env.XAI_API_KEY, model: resolveModelName('XAI_MODEL', 'grok-4.6') })]
  ];
  const providers = defs.filter(([key]) => process.env[key]).map(([, factory]) => factory());
  const strict = boolEnv('STRICT_COUNCIL', true);
  if (strict && providers.length !== 4) throw new Error('STRICT_COUNCIL=true requires OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, and XAI_API_KEY.');
  if (!providers.length) throw new Error('No AI providers configured. Add API keys or set DEMO_MODE=true.');
  return providers;
}

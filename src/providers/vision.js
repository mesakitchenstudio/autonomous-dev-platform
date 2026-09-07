import { boolEnv } from '../util/env.js';

export function providerSupportsVision(name, model, env = process.env) {
  const key = `${String(name || '').toUpperCase()}_VISION`;
  if (env[key] != null && String(env[key]).trim() !== '') return boolEnv(key, false);
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  if (m === 'mock' || name === 'mock') return true;
  if (name === 'openai') return !/tts|whisper|audio/.test(m);
  if (name === 'anthropic') return m.includes('claude');
  if (name === 'gemini') return true;
  if (name === 'xai') return m.includes('grok') || m.includes('vision');
  return false;
}

export function assertVisionSupported(provider, images) {
  if (!images?.length) return;
  if (provider.supportsVision) return;
  const error = new Error(`${provider.name} model ${provider.model} does not support image input`);
  error.code = 'VISION_UNSUPPORTED';
  throw error;
}

import { ModelProvider, providerFetch } from './provider.js';
import { throwHttpError } from './resilience.js';
import { normalizeUsage } from './usage.js';
import { assertVisionSupported, providerSupportsVision } from './vision.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export class AnthropicProvider extends ModelProvider {
  constructor({ apiKey, model, timeoutMs }) {
    super({ name: 'anthropic', model, timeoutMs, supportsVision: providerSupportsVision('anthropic', model) });
    this.apiKey = apiKey;
  }
  async complete({ system, prompt, images } = {}) {
    try { assertVisionSupported(this, images); } catch (error) {
      throw new PlatformError({ code: ErrorCode.VISION_UNSUPPORTED, message: error.message, phase: 'PROVIDER', retryable: false });
    }
    const content = images?.length
      ? [
        ...images.map(image => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType || 'image/png', data: image.data }
        })),
        { type: 'text', text: prompt }
      ]
      : prompt;
    const response = await providerFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: 10000, system, messages: [{ role: 'user', content }] })
    }, this.timeoutMs);
    if (!response.ok) throwHttpError('Anthropic', response.status, await response.text());
    const data = await response.json();
    return {
      text: (data.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n'),
      usage: normalizeUsage(data.usage)
    };
  }
}

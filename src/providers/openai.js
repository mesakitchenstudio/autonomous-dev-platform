import { ModelProvider, providerFetch } from './provider.js';
import { throwHttpError } from './resilience.js';
import { normalizeUsage } from './usage.js';
import { assertVisionSupported, providerSupportsVision } from './vision.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export class OpenAIProvider extends ModelProvider {
  constructor({ apiKey, model, timeoutMs }) {
    super({ name: 'openai', model, timeoutMs, supportsVision: providerSupportsVision('openai', model) });
    this.apiKey = apiKey;
  }
  async complete({ system, prompt, images } = {}) {
    try { assertVisionSupported(this, images); } catch (error) {
      throw new PlatformError({ code: ErrorCode.VISION_UNSUPPORTED, message: error.message, phase: 'PROVIDER', retryable: false });
    }
    const input = images?.length
      ? [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...images.map(image => ({ type: 'input_image', image_url: `data:${image.mimeType || 'image/png'};base64,${image.data}` }))
        ]
      }]
      : prompt;
    const response = await providerFetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, instructions: system, input })
    }, this.timeoutMs);
    if (!response.ok) throwHttpError('OpenAI', response.status, await response.text());
    const data = await response.json();
    const text = data.output_text || (data.output ?? []).flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
    return { text, usage: normalizeUsage(data.usage) };
  }
}

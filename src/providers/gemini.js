import { ModelProvider, providerFetch } from './provider.js';
import { throwHttpError } from './resilience.js';
import { normalizeUsage } from './usage.js';
import { assertVisionSupported, providerSupportsVision } from './vision.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';

export class GeminiProvider extends ModelProvider {
  constructor({ apiKey, model, timeoutMs }) {
    super({ name: 'gemini', model, timeoutMs, supportsVision: providerSupportsVision('gemini', model) });
    this.apiKey = apiKey;
  }
  async complete({ system, prompt, images } = {}) {
    try { assertVisionSupported(this, images); } catch (error) {
      throw new PlatformError({ code: ErrorCode.VISION_UNSUPPORTED, message: error.message, phase: 'PROVIDER', retryable: false });
    }
    const parts = [{ text: prompt }];
    for (const image of images || []) {
      parts.push({ inline_data: { mime_type: image.mimeType || 'image/png', data: image.data } });
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const response = await providerFetch(url, {
      method: 'POST', headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }] })
    }, this.timeoutMs);
    if (!response.ok) throwHttpError('Gemini', response.status, await response.text());
    const data = await response.json();
    return {
      text: (data.candidates?.[0]?.content?.parts ?? []).map(x => x.text ?? '').join('\n'),
      usage: normalizeUsage(data.usageMetadata)
    };
  }
}

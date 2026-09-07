import { ModelProvider, providerFetch } from './provider.js';

export class GeminiProvider extends ModelProvider {
  constructor({ apiKey, model, timeoutMs }) { super({ name: 'gemini', model, timeoutMs }); this.apiKey = apiKey; }
  async complete({ system, prompt }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const response = await providerFetch(url, {
      method: 'POST', headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] })
    }, this.timeoutMs);
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return (data.candidates?.[0]?.content?.parts ?? []).map(x => x.text ?? '').join('\n');
  }
}

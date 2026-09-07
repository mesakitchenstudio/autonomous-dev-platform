import { ModelProvider, providerFetch } from './provider.js';

export class XAIProvider extends ModelProvider {
  constructor({ apiKey, model, timeoutMs }) { super({ name: 'xai', model, timeoutMs }); this.apiKey = apiKey; }
  async complete({ system, prompt }) {
    const response = await providerFetch('https://api.x.ai/v1/responses', {
      method: 'POST', headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, instructions: system, input: prompt })
    }, this.timeoutMs);
    if (!response.ok) throw new Error(`xAI ${response.status}: ${await response.text()}`);
    const data = await response.json();
    if (data.output_text) return data.output_text;
    return (data.output ?? []).flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
  }
}

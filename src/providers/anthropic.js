import { ModelProvider, providerFetch } from './provider.js';

export class AnthropicProvider extends ModelProvider {
  constructor({ apiKey, model, timeoutMs }) { super({ name: 'anthropic', model, timeoutMs }); this.apiKey = apiKey; }
  async complete({ system, prompt }) {
    const response = await providerFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: 10000, system, messages: [{ role: 'user', content: prompt }] })
    }, this.timeoutMs);
    if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return (data.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  }
}

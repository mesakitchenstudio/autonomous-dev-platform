import { extractJson } from '../providers/provider.js';
import { councilSystem, discoveryPrompt, synthesisPrompt, reviewPrompt, reviewChairPrompt, finalVerificationPrompt } from './prompts.js';
import { ErrorCode, PlatformError, toErrorRecord } from '../orchestrator/errors.js';
import { withTimeout } from '../orchestrator/timeout.js';
import { intEnv } from '../util/env.js';

export class Council {
  constructor(providers, chairName = 'openai', { timeoutMs } = {}) {
    this.providers = providers;
    this.chair = providers.find(p => p.name === chairName) || providers[0];
    this.timeoutMs = timeoutMs ?? intEnv('AI_REQUEST_TIMEOUT_MS', 120000);
  }

  async completeProvider(provider, request, phase) {
    try {
      return await withTimeout(provider.complete(request), this.timeoutMs, {
        code: ErrorCode.PROVIDER_TIMEOUT,
        message: `${provider.name} timed out after ${this.timeoutMs}ms`,
        phase,
        details: { provider: provider.name }
      });
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError({
        code: ErrorCode.PROVIDER_FAILURE,
        message: error.message,
        phase,
        retryable: true,
        details: { provider: provider.name }
      });
    }
  }

  async independent(prompt, phase) {
    const settled = await Promise.allSettled(this.providers.map(async provider => ({
      provider: provider.name,
      output: extractJson(await this.completeProvider(provider, { system: councilSystem, prompt }, phase))
    })));
    const successes = settled.filter(x => x.status === 'fulfilled').map(x => x.value);
    const failures = settled
      .map((result, index) => result.status === 'rejected'
        ? { provider: this.providers[index].name, error: toErrorRecord(result.reason, phase) }
        : null)
      .filter(Boolean);
    if (!successes.length) {
      throw new PlatformError({
        code: ErrorCode.ALL_PROVIDERS_FAILED,
        message: 'Every council provider failed.',
        phase,
        retryable: true,
        details: { failures }
      });
    }
    return { successes, failures };
  }

  async chairComplete(request, phase) {
    try {
      const raw = await this.completeProvider(this.chair, request, phase);
      return extractJson(raw);
    } catch (error) {
      if (error instanceof PlatformError && error.code === ErrorCode.PROVIDER_TIMEOUT) {
        throw new PlatformError({
          code: ErrorCode.CHAIR_FAILURE,
          message: `Council Chair timed out: ${error.message}`,
          phase,
          retryable: true,
          details: { chair: this.chair?.name, cause: error.code }
        });
      }
      throw new PlatformError({
        code: ErrorCode.CHAIR_FAILURE,
        message: error.message,
        phase,
        retryable: true,
        details: { chair: this.chair?.name }
      });
    }
  }

  async discover(idea, repositoryContext = '') {
    const { successes: analyses, failures } = await this.independent(discoveryPrompt(idea, repositoryContext), 'COUNCIL_DISCOVERY');
    const spec = await this.chairComplete({
      system: `${councilSystem}\nYou are the Council Chair and final reasoning authority.`,
      prompt: synthesisPrompt(idea, analyses)
    }, 'COUNCIL_DISCOVERY');
    return { analyses, spec, chair: this.chair.name, failures };
  }

  async review(payload) {
    const { successes: reviews, failures } = await this.independent(reviewPrompt(payload), 'COUNCIL_REVIEW');
    const decision = await this.chairComplete({
      system: `${councilSystem}\nYou are the Council Chair. Never use simple majority voting; validate every material finding.`,
      prompt: reviewChairPrompt(reviews, payload.cursorResult)
    }, 'COUNCIL_REVIEW');
    return { reviews, decision, chair: this.chair.name, failures };
  }

  async finalVerify(payload) {
    const { successes: reviews, failures } = await this.independent(finalVerificationPrompt(payload), 'FINAL_VERIFICATION');
    const decision = await this.chairComplete({
      system: `${councilSystem}\nYou are the final release gate. You do not authorize owner review; the platform completion gate does.`,
      prompt: `FINAL_VERIFICATION_DECISION\nIndependent final reviews:\n${JSON.stringify(reviews)}\nReturn JSON {"decision":"COMPLETE|CHANGES_REQUIRED","blockingFindings":[],"summary":"...","nextCursorPrompt":"... or null"}`
    }, 'FINAL_VERIFICATION');
    return { reviews, decision, chair: this.chair.name, failures };
  }
}

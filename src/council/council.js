import crypto from 'node:crypto';
import { extractJson, unwrapComplete } from '../providers/provider.js';
import { councilSystem, chairSystem, discoveryPrompt, critiquePrompt, resolutionPrompt, synthesisPrompt, reviewPrompt, reviewChairPrompt, finalVerificationPrompt, architectureResolutionPrompt, repairPrompt } from './prompts.js';
import { visualChairPrompt, visualReviewPrompt } from '../visual/prompts.js';
import { visualChairSchema, visualReviewSchema } from '../visual/schema.js';
import { analysisSchema, critiqueSchema, resolutionSchema, specificationSchema, reviewSchema, reviewChairSchema, finalReviewSchema, architectureChoiceSchema, HIGH_SEVERITY } from './schemas.js';
import { validateObject } from './validate.js';
import { anonymizeAnalyses } from './anonymize.js';
import { collectMaterialDisagreements, shouldRunResolution } from './disagreement.js';
import { assertCursorPromptContract } from './cursor-contract.js';
import { ErrorCode, PlatformError, toErrorRecord } from '../orchestrator/errors.js';
import { withTimeout } from '../orchestrator/timeout.js';
import { intEnv } from '../util/env.js';
import { classifyProviderError, createRetryPolicy, ProviderStatus, withRetry } from '../providers/resilience.js';
import { resolveChairProvider } from '../providers/config.js';

export class Council {
  constructor(providers, chairName = 'openai', options = {}) {
    this.providers = providers;
    this.timeoutMs = options.timeoutMs ?? intEnv('AI_REQUEST_TIMEOUT_MS', 120000);
    this.minResponses = options.minResponses ?? intEnv('MIN_COUNCIL_RESPONSES', 4);
    this.maxReasoningRounds = options.maxReasoningRounds ?? intEnv('MAX_COUNCIL_REASONING_ROUNDS', 3);
    this.maxRepairAttempts = options.maxRepairAttempts ?? intEnv('AI_RESPONSE_REPAIR_ATTEMPTS', 1);
    this.retryPolicy = options.retryPolicy || createRetryPolicy();
    this.chair = options.chair || resolveChairSafe(providers, chairName);
  }

  async invokeProvider(provider, request, phase) {
    const raw = await withTimeout(provider.complete(request), this.timeoutMs, {
      code: ErrorCode.PROVIDER_TIMEOUT,
      message: `${provider.name} timed out after ${this.timeoutMs}ms`,
      phase,
      details: { provider: provider.name }
    });
    return unwrapComplete(raw);
  }

  async completeValidated(provider, request, schema, phase) {
    let lastErrors = [];
    let attempts = 0;
    const started = Date.now();
    for (let repair = 0; repair <= this.maxRepairAttempts; repair += 1) {
      const prompt = repair === 0 ? request.prompt : repairPrompt(request.prompt, lastErrors);
      try {
        const executed = await withRetry(() => this.invokeProvider(provider, { ...request, prompt, images: request.images }, phase), this.retryPolicy);
        attempts += executed.attempts;
        const parsed = extractJson(executed.result.text);
        const validation = validateObject(schema, parsed);
        if (validation.ok) {
          return {
            normalized: parsed,
            raw: executed.result.text,
            usage: executed.result.usage,
            attempts,
            durationMs: Date.now() - started,
            status: ProviderStatus.SUCCESS
          };
        }
        lastErrors = validation.errors;
      } catch (error) {
        attempts += error.attempts || 1;
        if (error instanceof PlatformError && error.code === ErrorCode.INVALID_RESPONSE) {
          lastErrors = [error.message];
        } else if (/did not return valid JSON/i.test(error.message || '')) {
          lastErrors = [error.message];
        } else {
          throw error;
        }
      }
    }
    throw new PlatformError({
      code: ErrorCode.INVALID_RESPONSE,
      message: `${provider.name} returned an invalid response after repair: ${lastErrors[0] || 'schema mismatch'}`,
      phase,
      retryable: false,
      details: { provider: provider.name, errors: lastErrors.slice(0, 8) }
    });
  }

  async independentRound({ prompt, schema, phase, purpose }) {
    const settled = await Promise.allSettled(this.providers.map(async provider => ({
      provider: provider.name,
      model: provider.model,
      ...(await this.completeValidated(provider, { system: councilSystem, prompt }, schema, phase))
    })));
    const valid = [];
    const failures = [];
    const participants = [];
    settled.forEach((item, index) => {
      const provider = this.providers[index];
      if (item.status === 'fulfilled') {
        valid.push(item.value);
        participants.push({
          provider: provider.name,
          model: provider.model,
          status: ProviderStatus.SUCCESS,
          attempts: item.value.attempts,
          durationMs: item.value.durationMs,
          usage: item.value.usage || null
        });
      } else {
        const classified = classifyProviderError(item.reason);
        failures.push({ provider: provider.name, status: classified.status, error: toErrorRecord(item.reason, phase) });
        participants.push({
          provider: provider.name,
          model: provider.model,
          status: classified.status,
          attempts: item.reason.attempts || 1,
          durationMs: null,
          usage: null
        });
      }
    });
    if (!valid.length) {
      throw new PlatformError({
        code: ErrorCode.ALL_PROVIDERS_FAILED,
        message: 'Every council provider failed.',
        phase,
        retryable: true,
        details: { failures }
      });
    }
    if (valid.length < this.minResponses) {
      throw new PlatformError({
        code: ErrorCode.INSUFFICIENT_COUNCIL,
        message: `Council needs at least ${this.minResponses} valid responses; received ${valid.length}.`,
        phase,
        retryable: true,
        details: { failures, received: valid.length, required: this.minResponses }
      });
    }
    return {
      valid,
      failures,
      participants,
      round: makeRound({ purpose, phase, participants, responses: valid, errors: failures })
    };
  }

  async chairValidated(request, schema, phase, extraValidate) {
    try {
      const result = await this.completeValidated(this.chair, { ...request, system: request.system || chairSystem }, schema, phase);
      extraValidate?.(result.normalized);
      return result;
    } catch (error) {
      throw new PlatformError({
        code: ErrorCode.CHAIR_FAILURE,
        message: error.message,
        phase,
        retryable: error.retryable !== false,
        details: { chair: this.chair?.name, model: this.chair?.model, cause: error.code }
      });
    }
  }

  async discover(idea, repositoryContext = '') {
    const history = [];
    const analysis = await this.independentRound({
      prompt: discoveryPrompt(idea, repositoryContext),
      schema: analysisSchema,
      phase: 'COUNCIL_DISCOVERY',
      purpose: 'independent_analysis'
    });
    history.push(analysis.round);

    const { proposals, mapping } = anonymizeAnalyses(analysis.valid);
    const critique = await this.independentRound({
      prompt: critiquePrompt(idea, repositoryContext, proposals),
      schema: critiqueSchema,
      phase: 'COUNCIL_DISCOVERY',
      purpose: 'critique'
    });
    critique.round.mapping = mapping;
    history.push(critique.round);

    let resolution = { valid: [], failures: [], participants: [], round: null };
    const disagreements = collectMaterialDisagreements(critique.valid);
    let reasoningRounds = 2;
    if (shouldRunResolution(critique.valid, { currentRounds: reasoningRounds, maxRounds: this.maxReasoningRounds })) {
      resolution = await this.independentRound({
        prompt: resolutionPrompt(idea, disagreements, proposals),
        schema: resolutionSchema,
        phase: 'COUNCIL_DISCOVERY',
        purpose: 'resolution'
      });
      history.push(resolution.round);
      reasoningRounds += 1;
    }

    const chairResult = await this.chairValidated({
      system: chairSystem,
      prompt: synthesisPrompt(
        idea,
        repositoryContext,
        analysis.valid.map(item => ({ provider: item.provider, output: item.normalized })),
        critique.valid.map(item => item.normalized),
        resolution.valid.map(item => item.normalized)
      )
    }, specificationSchema, 'COUNCIL_DISCOVERY', spec => {
      assertCursorPromptContract(spec.cursorPrompt);
    });
    const spec = normalizeSpecification(chairResult.normalized);
    history.push(makeRound({
      purpose: 'chair_synthesis',
      phase: 'COUNCIL_DISCOVERY',
      participants: [{ provider: this.chair.name, model: this.chair.model, status: ProviderStatus.SUCCESS, attempts: chairResult.attempts, durationMs: chairResult.durationMs, usage: chairResult.usage || null }],
      responses: [{ provider: this.chair.name, normalized: spec }],
      chair: { provider: this.chair.name, model: this.chair.model }
    }));

    return {
      analyses: analysis.valid.map(item => ({ provider: item.provider, output: item.normalized })),
      spec,
      chair: this.chair.name,
      chairModel: this.chair.model,
      failures: [...analysis.failures, ...critique.failures, ...resolution.failures],
      history,
      participation: {
        analysis: analysis.participants,
        critique: critique.participants,
        resolution: resolution.participants,
        chair: { provider: this.chair.name, model: this.chair.model, status: ProviderStatus.SUCCESS }
      },
      disagreements,
      mapping,
      reasoningRounds
    };
  }

  async review(payload) {
    const history = [];
    const members = await this.independentRound({
      prompt: reviewPrompt(payload),
      schema: reviewSchema,
      phase: 'COUNCIL_REVIEW',
      purpose: 'implementation_review'
    });
    history.push(members.round);
    const decisionResult = await this.chairValidated({
      system: chairSystem,
      prompt: reviewChairPrompt(members.valid.map(item => ({ provider: item.provider, output: item.normalized })), payload.cursorResult, payload.iteration, payload.platformVerification, {
        runtimeVerification: payload.runtimeVerification,
        visualVerification: payload.visualVerification
      })
    }, reviewChairSchema, 'COUNCIL_REVIEW', decision => {
      assertReviewChairDecision(decision, members.valid);
    });
    history.push(makeRound({
      purpose: 'review_chair',
      phase: 'COUNCIL_REVIEW',
      iteration: payload.iteration,
      participants: [{ provider: this.chair.name, model: this.chair.model, status: ProviderStatus.SUCCESS, attempts: decisionResult.attempts, durationMs: decisionResult.durationMs, usage: decisionResult.usage || null }],
      chair: { provider: this.chair.name, decision: decisionResult.normalized }
    }));
    return {
      reviews: members.valid.map(item => ({ provider: item.provider, output: item.normalized })),
      decision: decisionResult.normalized,
      chair: this.chair.name,
      failures: members.failures,
      history
    };
  }

  async finalVerify(payload) {
    const history = [];
    const members = await this.independentRound({
      prompt: finalVerificationPrompt(payload),
      schema: finalReviewSchema,
      phase: 'FINAL_VERIFICATION',
      purpose: 'final_review'
    });
    history.push(members.round);
    const decisionResult = await this.chairValidated({
      system: `${chairSystem}\nYou are the final release gate. You do not authorize owner review; the platform completion gate does.`,
      prompt: finalVerificationPrompt({ ...payload, history: members.valid.map(item => item.normalized) })
    }, finalReviewSchema, 'FINAL_VERIFICATION', decision => {
      assertFinalDecision(decision);
    });
    history.push(makeRound({
      purpose: 'final_chair',
      phase: 'FINAL_VERIFICATION',
      participants: [{ provider: this.chair.name, model: this.chair.model, status: ProviderStatus.SUCCESS, attempts: decisionResult.attempts, durationMs: decisionResult.durationMs, usage: decisionResult.usage || null }],
      chair: { provider: this.chair.name, decision: decisionResult.normalized }
    }));
    return {
      reviews: members.valid.map(item => ({ provider: item.provider, output: item.normalized })),
      decision: decisionResult.normalized,
      chair: this.chair.name,
      failures: members.failures,
      history
    };
  }

  async resolveArchitecture(payload) {
    const result = await this.chairValidated({
      system: chairSystem,
      prompt: architectureResolutionPrompt(payload)
    }, architectureChoiceSchema, 'PROJECT_PROVISIONING');
    return result.normalized;
  }

  async visualReview(payload) {
    const visionProviders = this.providers.filter(provider => provider.supportsVision);
    const reviewers = visionProviders.length ? visionProviders : this.providers;
    const findings = [];
    const reviewerRecords = [];
    const usage = [];
    for (const screen of payload.screens || []) {
      const selected = reviewers.slice(0, screen.reviewerCount || reviewers.length);
      const settled = await Promise.allSettled(selected.map(async provider => {
        const result = await this.completeValidated(provider, {
          system: councilSystem,
          prompt: visualReviewPrompt({
            spec: payload.spec,
            acceptance: payload.acceptance,
            screen: screen.purpose,
            viewport: screen.viewport,
            diagnostics: screen.diagnostics,
            priorFindings: screen.priorFindings,
            checkpointSha: screen.checkpointSha
          }),
          images: screen.images
        }, visualReviewSchema, 'VISUAL_VERIFICATION');
        return { provider: provider.name, model: provider.model, ...result };
      }));
      settled.forEach((item, index) => {
        if (item.status === 'fulfilled') {
          reviewerRecords.push({
            provider: selected[index].name,
            model: selected[index].model,
            decision: item.value.normalized.decision,
            findings: item.value.normalized.findings
          });
          findings.push(...(item.value.normalized.findings || []).map(finding => ({
            ...finding,
            reviewer: selected[index].name,
            screen: item.value.normalized.screen,
            device: item.value.normalized.device,
            provenance: 'AI_REVIEWED'
          })));
          usage.push({ provider: selected[index].name, usage: item.value.usage || null });
        }
      });
    }
    const layout = (payload.layoutFindings || []).map(item => ({ ...item, provenance: item.provenance || 'PLATFORM_VERIFIED' }));
    const chairResult = await this.chairValidated({
      system: chairSystem,
      prompt: visualChairPrompt([...reviewerRecords, ...layout], { layoutFindings: layout })
    }, visualChairSchema, 'VISUAL_VERIFICATION', decision => {
      const blockingHigh = (decision.blockingFindings || []).filter(item => HIGH_SEVERITY.has(item.severity));
      if (decision.decision === 'COMPLETE' && blockingHigh.length) {
        throw new Error('Visual COMPLETE cannot include unresolved HIGH/CRITICAL findings');
      }
      const minority = [...findings, ...layout].filter(item => HIGH_SEVERITY.has(item.severity));
      const addressed = [...(decision.resolvedFindings || []), ...(decision.blockingFindings || [])];
      for (const finding of minority) {
        const ok = addressed.some(entry => (
          entry.description === finding.description
          || entry.category === finding.category
        ));
        if (!ok) throw new Error('Visual chair ignored a HIGH/CRITICAL finding; majority cannot override it');
      }
    });
    return {
      reviewers: reviewerRecords,
      findings: [...findings, ...layout],
      chair: { provider: this.chair.name, decision: chairResult.normalized },
      decision: chairResult.normalized,
      usage
    };
  }
}

function resolveChairSafe(providers, chairName) {
  try {
    return resolveChairProvider(providers, chairName);
  } catch {
    return providers.find(provider => provider.name === chairName) || providers[0];
  }
}

export function normalizeSpecification(spec) {
  const productName = spec.productName || spec.product?.name;
  return {
    ...spec,
    productName,
    productSummary: spec.productSummary || spec.product?.summary || '',
    projectType: spec.projectType || spec.product?.type || 'application',
    product: {
      name: productName,
      summary: spec.product?.summary || spec.productSummary || '',
      type: spec.product?.type || spec.projectType || 'application',
      targetUsers: spec.product?.targetUsers || []
    }
  };
}

export function assertReviewChairDecision(decision, reviews) {
  if (decision.decision === 'CHANGES_REQUIRED' && !String(decision.nextCursorPrompt || '').trim()) {
    throw new Error('CHANGES_REQUIRED requires a non-empty nextCursorPrompt');
  }
  const blockingHigh = (decision.blockingFindings || []).filter(item => HIGH_SEVERITY.has(item.severity));
  if (decision.decision === 'COMPLETE' && blockingHigh.length) {
    throw new Error('COMPLETE cannot include unresolved HIGH/CRITICAL blocking findings');
  }
  const minorityHigh = reviews.flatMap(item => (item.normalized?.findings || []).filter(finding => HIGH_SEVERITY.has(finding.severity)));
  const addressed = [...(decision.resolvedFindings || []), ...(decision.blockingFindings || [])];
  for (const finding of minorityHigh) {
    const ok = addressed.some(entry => entry.issue === finding.issue || (entry.category === finding.category && entry.severity === finding.severity));
    if (!ok) throw new Error('Chair ignored a HIGH/CRITICAL minority finding; majority cannot override it');
  }
}

export function assertFinalDecision(decision) {
  const blockingHigh = (decision.blockingFindings || []).filter(item => HIGH_SEVERITY.has(item.severity));
  if (decision.decision === 'COMPLETE' && blockingHigh.length) {
    throw new Error('Final COMPLETE is invalid while HIGH/CRITICAL blocking findings remain');
  }
  if (decision.decision === 'CHANGES_REQUIRED' && !String(decision.nextCursorPrompt || '').trim()) {
    throw new Error('CHANGES_REQUIRED requires a non-empty nextCursorPrompt');
  }
}

function makeRound({ purpose, phase, participants = [], responses = [], errors = [], chair = null, iteration = 0, mapping = null }) {
  return {
    id: crypto.randomUUID(),
    purpose,
    phase,
    iteration,
    at: new Date().toISOString(),
    participants,
    responses: responses.map(item => ({
      provider: item.provider,
      normalized: item.normalized,
      rawPreview: typeof item.raw === 'string' ? item.raw.slice(0, 400) : null,
      usage: item.usage || null,
      attempts: item.attempts,
      durationMs: item.durationMs
    })),
    errors,
    chair,
    mapping,
    disagreements: collectMaterialDisagreements(responses)
  };
}

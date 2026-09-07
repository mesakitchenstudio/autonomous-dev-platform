export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = firstNumber(raw.input_tokens, raw.prompt_tokens, raw.promptTokenCount, raw.inputTokens);
  const output = firstNumber(raw.output_tokens, raw.completion_tokens, raw.candidatesTokenCount, raw.outputTokens);
  const total = firstNumber(raw.total_tokens, raw.totalTokenCount, raw.totalTokens);
  if (input == null && output == null && total == null) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total != null ? total : (input != null && output != null ? input + output : null)
  };
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

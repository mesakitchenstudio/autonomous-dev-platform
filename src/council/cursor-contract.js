export const CURSOR_PROMPT_SECTIONS = Object.freeze([
  'OBJECTIVE',
  'CONTEXT',
  'REQUIREMENTS',
  'ARCHITECTURE',
  'CONSTRAINTS',
  'SCOPE',
  'DO NOT',
  'TESTING',
  'REGRESSION',
  'ACCEPTANCE',
  'EVIDENCE'
]);

export function missingCursorPromptSections(prompt) {
  const text = String(prompt || '');
  return CURSOR_PROMPT_SECTIONS.filter(section => !new RegExp(`\\b${section.replace(' ', '\\s+')}\\b`, 'i').test(text));
}

export function assertCursorPromptContract(prompt) {
  const missing = missingCursorPromptSections(prompt);
  if (missing.length) {
    const error = new Error(`Cursor prompt is missing required sections: ${missing.join(', ')}`);
    error.missingSections = missing;
    throw error;
  }
  if (/release (control.plane )?secrets|privileged sandbox|mount host root|unrestricted network/i.test(String(prompt || ''))) {
    const error = new Error('Cursor prompt attempted to authorize a security-policy change.');
    error.code = 'SANDBOX_VIOLATION';
    throw error;
  }
  return true;
}

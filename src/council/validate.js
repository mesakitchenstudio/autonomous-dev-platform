export function validateObject(schema, value, path = '$') {
  const errors = [];
  walk(schema, value, path, errors);
  return { ok: errors.length === 0, errors };
}

function walk(schema, value, path, errors) {
  if (!schema) return;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return;
    }
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    value.forEach((item, index) => {
      if (typeof schema.items === 'string') {
        if (typeof item !== schema.items) errors.push(`${path}[${index}] must be ${schema.items}`);
      } else {
        walk(schema.items, item, `${path}[${index}]`, errors);
      }
    });
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const key of schema.required || []) {
      if (value[key] == null || value[key] === '') errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) walk(child, value[key], `${path}.${key}`, errors);
    }
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path} must be a string`);
    else if (schema.minLength && value.trim().length < schema.minLength) errors.push(`${path} is too short`);
    else if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    return;
  }
  if (schema.type === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path} must be a number`);
    return;
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
}

export function assertValid(schema, value, message) {
  const result = validateObject(schema, value);
  if (!result.ok) {
    const error = new Error(`${message}: ${result.errors.slice(0, 6).join('; ')}`);
    error.validationErrors = result.errors;
    throw error;
  }
  return value;
}

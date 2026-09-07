const values = new Set();

export function rememberBrokerValue(value) {
  if (typeof value === 'string' && value.length >= 4) values.add(value);
}

export function forgetBrokerValue(value) {
  values.delete(value);
}

export function knownBrokerValues() {
  return [...values];
}

export function resetBrokerValuesForTests() {
  values.clear();
}
